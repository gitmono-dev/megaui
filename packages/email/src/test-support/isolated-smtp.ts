// megaui-only (FS-88): an owned SMTP receiver in a run-labelled container.
import { execFile } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IMAGE = "node:24-alpine";
const LABEL = "megaui-fs88-run";

export interface IsolatedSmtp {
  readonly runId: string;
  readonly containerName: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly sendProbe: () => Promise<void>;
  readonly close: () => Promise<void>;
}

const SMTP_SCRIPT = [
  "const net=require('node:net');",
  "const s=net.createServer(c=>{let data=false;c.setEncoding('utf8');c.write('220 fs88 smtp\\r\\n');",
  "c.on('data',x=>{for(const l of x.split(/\\r?\\n/)){if(!l)continue;if(data){if(l==='.') {data=false;c.write('250 queued\\r\\n');}continue;}",
  "const u=l.toUpperCase();if(u.startsWith('DATA')){data=true;c.write('354 data\\r\\n');}else if(u.startsWith('QUIT')){c.end('221 bye\\r\\n');}",
  "else if(u.startsWith('EHLO')||u.startsWith('HELO'))c.write('250 fs88\\r\\n');else if(u.startsWith('MAIL')||u.startsWith('RCPT'))c.write('250 ok\\r\\n');else c.write('250 ok\\r\\n');}});",
  "});s.listen(2525,'0.0.0.0');",
].join("");

async function command(args: readonly string[]): Promise<string> {
  const result = await execFileAsync("docker", args, { timeout: 30_000, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

async function mappedPort(name: string): Promise<number> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const output = await command(["port", name, "2525/tcp"]);
      const match = /:(\d+)\s*$/.exec(output);
      if (match) return Number(match[1]);
    } catch { /* container is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("FS88 SMTP did not publish a loopback port");
}

function readReply(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const onData = (chunk: Buffer | string) => {
      data += String(chunk);
      if (data.includes("\n")) { cleanup(); resolve(data); }
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("FS88 SMTP probe timed out")); }, 5_000);
    const cleanup = () => { clearTimeout(timer); socket.off("data", onData); socket.off("error", onError); };
    socket.on("data", onData); socket.once("error", onError);
  });
}

export async function createIsolatedSmtp(runId: string): Promise<IsolatedSmtp> {
  const containerName = `megaui-fs88-smtp-${runId}`;
  await command(["run", "-d", "--name", containerName, "--label", `${LABEL}=${runId}`, "-p", "127.0.0.1::2525", IMAGE, "node", "-e", SMTP_SCRIPT]);
  const port = await mappedPort(containerName);
  const probe = async (): Promise<void> => {
    const socket = createConnection({ host: "127.0.0.1", port });
    try {
      await readReply(socket);
      socket.write("EHLO fs88\r\n"); await readReply(socket);
      socket.write("MAIL FROM:<fs88@example.test>\r\n"); await readReply(socket);
      socket.write("RCPT TO:<fs88@example.test>\r\n"); await readReply(socket);
      socket.write("DATA\r\n"); await readReply(socket);
      socket.write("Subject: fs88\r\n\r\nprobe\r\n.\r\n"); await readReply(socket);
      socket.write("QUIT\r\n"); await readReply(socket);
    } finally { socket.destroy(); }
  };
  try {
    await probe();
  } catch (error) {
    await command(["rm", "-f", containerName]).catch(() => undefined);
    throw error;
  }
  let closed = false;
  return {
    runId, containerName, host: "127.0.0.1", port, sendProbe: probe,
    close: async () => {
      if (closed) return;
      closed = true;
      await command(["rm", "-f", containerName]);
    },
  };
}

