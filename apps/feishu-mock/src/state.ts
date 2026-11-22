/**
 * FSM-01：每 run 的合成凭据与独占 runtime 文件。
 *
 * runtime 只在本进程内存在：四个秘密每 run 随机生成，默认写在系统临时目录
 * 下由 CLI 独占创建的 0700 目录中，文件以 0600 独占创建。
 *
 * FSM-07 起本文件同时承载本 run 的合成目录：固定的 synthetic App、成员与部门，
 * 以及成员状态到冻结四布尔组合的映射。这里没有任何真实人员数据。
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  opendirSync,
  rmdirSync,
  rmSync,
  statSync,
  writeSync,
  type Dir,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const MOCK_APP_ID = "cli_mock_megaui";
export const MOCK_TENANT_KEY = "tenant_mock_megaui";
export const MOCK_RUNTIME_SCHEMA_VERSION = 1;

export const MOCK_DEPARTMENT_ENGINEERING = "od_mock_engineering";
export const MOCK_DEPARTMENT_OPERATIONS = "od_mock_operations";

/** The four status flags the frozen contract uses to express the status enum. */
export interface MockUserStatusFlags {
  is_activated: boolean;
  is_frozen: boolean;
  is_resigned: boolean;
  is_exited: boolean;
}

/** The status enum of a synthetic member. */
export type MockUserStatus = "active" | "suspended" | "resigned";

/** Maps the status enum onto the frozen four boolean flags. */
export function statusFlags(status: MockUserStatus): MockUserStatusFlags {
  switch (status) {
    case "active":
      return { is_activated: true, is_frozen: false, is_resigned: false, is_exited: false };
    case "suspended":
      return { is_activated: true, is_frozen: true, is_resigned: false, is_exited: false };
    case "resigned":
      return { is_activated: false, is_frozen: false, is_resigned: true, is_exited: true };
  }
}

export interface MockUser {
  open_id: string;
  user_id: string;
  union_id: string;
  name: string;
  mobile: string;
  department_ids: string[];
  email: string;
  enterprise_email: string;
  status: MockUserStatusFlags;
}

export interface MockDepartment {
  open_department_id: string;
  name: string;
}

/** A message kept in a member inbox. */
export interface MockInboxEntry {
  messageId: string;
  receiveId: string;
  msgType: string;
  content: string;
  /** The creation time in milliseconds, as a decimal string. */
  createTime: string;
}

/** A bounded fault rule. */
export interface MockFaultRule {
  target: "token" | "directory" | "user" | "message";
  kind: "429" | "403" | "500" | "timeout" | "disconnect_after_accept";
  count: number;
  skip: number;
}

/**
 * The fixed synthetic fixture.
 *
 * Every value is obviously synthetic: reserved test domains for every
 * address, an empty address for the third member and no real person data
 * anywhere.
 */
export const SYNTHETIC_USERS: readonly MockUser[] = [
  {
    open_id: "ou_mock_alice",
    user_id: "u_mock_alice",
    union_id: "on_mock_alice",
    name: "Mock Alice",
    mobile: "+15550000001",
    department_ids: [MOCK_DEPARTMENT_ENGINEERING],
    email: "alice@example.com",
    enterprise_email: "",
    status: statusFlags("active"),
  },
  {
    open_id: "ou_mock_bob",
    user_id: "u_mock_bob",
    union_id: "on_mock_bob",
    name: "Mock Bob",
    mobile: "+15550000002",
    department_ids: [MOCK_DEPARTMENT_ENGINEERING],
    email: "bob@example.com",
    enterprise_email: "",
    status: statusFlags("active"),
  },
  {
    open_id: "ou_mock_carol",
    user_id: "u_mock_carol",
    union_id: "on_mock_carol",
    name: "Mock Carol",
    mobile: "+15550000003",
    department_ids: [MOCK_DEPARTMENT_OPERATIONS],
    email: "",
    enterprise_email: "",
    status: statusFlags("active"),
  },
  // FSL-118: three members outside every department, so they never appear in
  // the department pages. They exist for the Directory v1 employee routes: one
  // with only an enterprise address, and two sharing one enterprise address.
  {
    open_id: "ou_mock_dave",
    user_id: "u_mock_dave",
    union_id: "on_mock_dave",
    name: "Mock Dave",
    mobile: "+15550000004",
    department_ids: [],
    email: "",
    enterprise_email: "dave@corp.example.com",
    status: statusFlags("active"),
  },
  {
    open_id: "ou_mock_erin",
    user_id: "u_mock_erin",
    union_id: "on_mock_erin",
    name: "Mock Erin",
    mobile: "+15550000005",
    department_ids: [],
    email: "",
    enterprise_email: "shared@corp.example.com",
    status: statusFlags("active"),
  },
  {
    open_id: "ou_mock_frank",
    user_id: "u_mock_frank",
    union_id: "on_mock_frank",
    name: "Mock Frank",
    mobile: "+15550000006",
    department_ids: [],
    email: "",
    enterprise_email: "shared@corp.example.com",
    status: statusFlags("active"),
  },
];

export const SYNTHETIC_DEPARTMENTS: readonly MockDepartment[] = [
  { open_department_id: MOCK_DEPARTMENT_ENGINEERING, name: "Mock Engineering" },
  { open_department_id: MOCK_DEPARTMENT_OPERATIONS, name: "Mock Operations" },
];

/** The state of one run. */
export interface MockState {
  users: MockUser[];
  departments: MockDepartment[];
  inboxes: Map<string, MockInboxEntry[]>;
  faults: MockFaultRule[];
}

/** Creates the initial state from the frozen synthetic fixture. */
export function createMockState(): MockState {
  return {
    users: SYNTHETIC_USERS.map((user) => ({
      ...user,
      department_ids: [...user.department_ids],
      status: { ...user.status },
    })),
    departments: SYNTHETIC_DEPARTMENTS.map((department) => ({ ...department })),
    inboxes: new Map<string, MockInboxEntry[]>(),
    faults: [],
  };
}

/**
 * Restores the synthetic initial state.
 *
 * This is the only way the run state changes wholesale, and it is owned by the
 * registered store: the run configuration (app id, tenant key and the admin
 * bearer) lives outside the state and therefore survives a reset.
 */
export function resetMockState(state: MockState): void {
  state.users = SYNTHETIC_USERS.map((user) => ({
    ...user,
    department_ids: [...user.department_ids],
    status: { ...user.status },
  }));
  state.departments = SYNTHETIC_DEPARTMENTS.map((department) => ({ ...department }));
  state.inboxes = new Map<string, MockInboxEntry[]>();
  state.faults = [];
}

export interface MockSecrets {
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  adminToken: string;
}

export interface MockRuntime {
  schemaVersion: typeof MOCK_RUNTIME_SCHEMA_VERSION;
  baseUrl: string;
  appId: string;
  tenantKey: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  adminToken: string;
}

export interface MockRuntimeTarget {
  file: string;
  /** Set only when this process created the directory; a caller-specified directory is never removed. */
  ownedDirectory: string | undefined;
  /** Identity (dev:ino) of the directory this process created, when it did. */
  directoryIdentity: string | undefined;
  /** True once this process created the runtime file; only then may it be removed. */
  created: boolean;
  /** Identity (dev:ino) of the file this process created, taken from its own descriptor. */
  identity: string | undefined;
  /** The descriptor stays open for the run so its inode cannot be recycled under us. */
  descriptor: number | undefined;
  /** Open handle on the directory this process created; pins its inode for the run. */
  directoryHandle: Dir | undefined;
}

export class MockRuntimeError extends Error {
  readonly code:
    | "mock_runtime_file_exists"
    | "mock_runtime_file_symlink"
    | "mock_runtime_directory_missing"
    | "mock_runtime_write_failed";

  constructor(code: MockRuntimeError["code"], message: string) {
    super(message);
    this.name = "MockRuntimeError";
    this.code = code;
  }
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function createRunSecrets(): MockSecrets {
  return {
    appSecret: randomSecret(),
    verificationToken: randomSecret(),
    encryptKey: randomSecret(),
    adminToken: randomSecret(),
  };
}

/**
 * Prepares the exclusive runtime target. A caller-specified file must not
 * exist and must not be a symlink; otherwise a private temporary directory
 * is created for this run.
 */
export function prepareRuntimeTarget(runtimeFile: string | undefined): MockRuntimeTarget {
  if (runtimeFile !== undefined) {
    const file = resolve(runtimeFile);
    let stats;
    try {
      stats = lstatSync(file);
    } catch {
      stats = undefined;
    }
    if (stats) {
      throw new MockRuntimeError(
        stats.isSymbolicLink() ? "mock_runtime_file_symlink" : "mock_runtime_file_exists",
        `runtime file already exists: ${file}`,
      );
    }
    const parent = dirname(file);
    if (!existsSync(parent)) {
      throw new MockRuntimeError(
        "mock_runtime_directory_missing",
        `runtime directory does not exist: ${parent}`,
      );
    }
    return {
      file,
      ownedDirectory: undefined,
      directoryIdentity: undefined,
      created: false,
      identity: undefined,
      descriptor: undefined,
      directoryHandle: undefined,
    };
  }
  const directory = mkdtempSync(join(tmpdir(), "megaui-feishu-mock-"));
  chmodSync(directory, 0o700);
  const directoryStats = statSync(directory);
  return {
    file: join(directory, "runtime.json"),
    ownedDirectory: directory,
    directoryIdentity: `${directoryStats.dev}:${directoryStats.ino}`,
    created: false,
    identity: undefined,
    descriptor: undefined,
    directoryHandle: opendirSync(directory),
  };
}

/** Writes the runtime file with 0600 and refuses to replace an existing file. */
export function writeRuntimeFile(target: MockRuntimeTarget, runtime: MockRuntime): void {
  let descriptor: number;
  try {
    descriptor = openSync(target.file, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new MockRuntimeError("mock_runtime_file_exists", `runtime file already exists: ${target.file}`);
    }
    throw new MockRuntimeError(
      "mock_runtime_write_failed",
      `cannot create runtime file: ${target.file}`,
    );
  }
  target.created = true;
  try {
    // The identity is taken from the descriptor we opened, and that descriptor
    // stays open for the run, so the inode cannot be recycled into a
    // replacement file before cleanup.
    const stats = fstatSync(descriptor);
    target.identity = `${stats.dev}:${stats.ino}`;
  } catch {
    target.identity = undefined;
  }
  target.descriptor = descriptor;
  const payload = Buffer.from(`${JSON.stringify(runtime)}\n`, "utf8");
  let written = 0;
  try {
    while (written < payload.length) {
      written += writeSync(descriptor, payload, written, payload.length - written);
    }
  } catch (error) {
    // Remove the partial file while its descriptor still pins the inode, then
    // forget ownership so no later cleanup can delete a replacement file.
    try {
      const stats = fstatSync(descriptor);
      const current = lstatSync(target.file);
      if (current.isFile() && `${current.dev}:${current.ino}` === `${stats.dev}:${stats.ino}`) {
        rmSync(target.file, { force: true });
      }
    } catch {
      // Nothing of ours remains at the path.
    }
    closeSync(descriptor);
    target.descriptor = undefined;
    target.created = false;
    target.identity = undefined;
    throw error;
  }
}

/**
 * Removes the runtime file this process created and, when this process created
 * the directory, that directory. A file created by somebody else is left alone,
 * and a directory that is no longer empty is kept.
 */
export function removeRuntimeTarget(target: MockRuntimeTarget): void {
  const closeOwned = () => {
    if (target.descriptor !== undefined) {
      try {
        closeSync(target.descriptor);
      } catch {
        // Already closed; nothing to release.
      }
      target.descriptor = undefined;
    }
  };
  if (target.created && target.identity) {
    try {
      const stats = lstatSync(target.file);
      if (stats.isFile() && `${stats.dev}:${stats.ino}` === target.identity) {
        rmSync(target.file, { force: true });
      }
    } catch {
      // The file is already gone; nothing of ours remains to remove.
    }
  }
  closeOwned();
  if (target.ownedDirectory && target.directoryIdentity) {
    try {
      const stats = lstatSync(target.ownedDirectory);
      if (stats.isDirectory() && `${stats.dev}:${stats.ino}` === target.directoryIdentity) {
        rmdirSync(target.ownedDirectory);
      }
    } catch {
      // The directory is gone, replaced, or no longer empty; none of those is ours to remove.
    }
  }
  if (target.directoryHandle) {
    try {
      target.directoryHandle.closeSync();
    } catch {
      // Already closed; nothing to release.
    }
    target.directoryHandle = undefined;
  }
}
