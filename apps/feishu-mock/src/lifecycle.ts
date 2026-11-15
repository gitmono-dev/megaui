/**
 * FSM-08：本 run 的资源注册与生命周期。
 *
 * 业务 store 与异步任务只能通过本模块的注册接口进入运行态：未注册的资源既不
 * 参与 reset，也不能在 reset 之后写回。reset 先递增 generation、取消并等待
 * 全部已注册在途任务，再逐个调用已注册 store 的重置器；旧 generation 的异步
 * 完成因此无法写回新状态。
 */

/** A business store that can restore its own initial state. */
export interface MockStore {
  readonly name: string;
  /** Restores the store to the state this run started with. */
  reset(): void;
}

/** The handle an asynchronous task uses to write back. */
export interface MockTaskContext {
  readonly name: string;
  /** The generation the task started in. */
  readonly generation: number;
  /** True once the task was aborted or the run was reset. */
  readonly aborted: boolean;
  /**
   * Applies the effect only while this task's generation is still current.
   * Returns false when the run was reset in the meantime.
   */
  commit(effect: () => void): boolean;
}

interface RunningTask {
  context: MockTaskContext;
  abort: () => void;
  finished: Promise<void>;
}

/** Raised when a store or task name is registered twice. */
export class MockLifecycleError extends Error {
  readonly code: "mock_lifecycle_duplicate_name" | "mock_lifecycle_unknown_task";

  constructor(code: MockLifecycleError["code"], message: string) {
    super(message);
    this.name = "MockLifecycleError";
    this.code = code;
  }
}

export class MockLifecycle {
  #generation = 1;
  #stores: MockStore[] = [];
  #storeNames = new Set<string>();
  #tasks = new Map<string, RunningTask>();

  /** The current generation; a reset increments it. */
  get generation(): number {
    return this.#generation;
  }

  /** The registered stores, in registration order. */
  get stores(): readonly MockStore[] {
    return this.#stores;
  }

  /** The names of the tasks that are still running. */
  get taskNames(): string[] {
    return [...this.#tasks.keys()];
  }

  /**
   * Registers a business store. A store is the only thing that may change the
   * run state, and only a registered store is reset.
   */
  registerStore(store: MockStore): MockStore {
    if (this.#storeNames.has(store.name)) {
      throw new MockLifecycleError(
        "mock_lifecycle_duplicate_name",
        `store already registered: ${store.name}`,
      );
    }
    this.#storeNames.add(store.name);
    this.#stores.push(store);
    return store;
  }

  /** True while the given generation is still the current one. */
  isCurrent(generation: number): boolean {
    return generation === this.#generation;
  }

  /**
   * Runs an asynchronous task under the current generation.
   *
   * The task is registered before it starts, so a reset always sees it. The
   * returned promise resolves when the task body settled. A duplicate name is
   * refused synchronously, so a caller can rely on the throw.
   */
  startTask(name: string, body: (context: MockTaskContext) => Promise<void>): Promise<void> {
    if (this.#tasks.has(name)) {
      throw new MockLifecycleError("mock_lifecycle_duplicate_name", `task already registered: ${name}`);
    }
    const generation = this.#generation;
    let aborted = false;
    let resolveFinished: () => void = () => undefined;
    const finished = new Promise<void>((resolvePromise) => {
      resolveFinished = resolvePromise;
    });
    const context: MockTaskContext = {
      name,
      generation,
      get aborted(): boolean {
        return aborted;
      },
      commit: (effect: () => void): boolean => {
        if (aborted || !this.isCurrent(generation)) return false;
        effect();
        return true;
      },
    };
    const running: RunningTask = {
      context,
      abort: () => {
        aborted = true;
      },
      finished,
    };
    this.#tasks.set(name, running);
    return (async () => {
      try {
        await body(context);
      } finally {
        resolveFinished();
        if (this.#tasks.get(name) === running) this.#tasks.delete(name);
      }
    })();
  }

  /**
   * Resets the run.
   *
   * The generation is incremented first, so any completion of an older task
   * can no longer write back. Every registered task is then aborted and awaited
   * before the registered stores restore their initial state, and the reset
   * only reports success once all of that has happened.
   */
  async reset(): Promise<number> {
    this.#generation += 1;
    const tasks = [...this.#tasks.values()];
    for (const task of tasks) task.abort();
    await Promise.all(tasks.map((task) => task.finished));
    this.#tasks.clear();
    for (const store of this.#stores) store.reset();
    return this.#generation;
  }

  /** Aborts every registered task without resetting the stores. */
  async shutdown(): Promise<void> {
    const tasks = [...this.#tasks.values()];
    for (const task of tasks) task.abort();
    await Promise.all(tasks.map((task) => task.finished));
    this.#tasks.clear();
  }
}
