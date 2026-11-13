import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

/** Minimal line-delimited JSON-RPC client for the stdio server. */
export class StdioClient {
	private readonly proc: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<number, (msg: any) => void>();
	private buf = "";
	private nextId = 1;
	stderr = "";

	constructor(command: string, args: string[], cwd: string) {
		this.proc = spawn(command, args, {
			cwd,
			// Only PATH and the key: proves nothing else (Cloudflare, GitHub) is needed.
			// No update check, so tests never reach GitHub.
			env: { PATH: process.env.PATH ?? "", GARMIN_API_KEY: "dummy", GARMIN_MCP_NO_UPDATE_CHECK: "1" },
		});
		this.proc.stdout.setEncoding("utf8");
		this.proc.stdout.on("data", (chunk: string) => {
			this.buf += chunk;
			let nl: number;
			while ((nl = this.buf.indexOf("\n")) >= 0) {
				const line = this.buf.slice(0, nl).trim();
				this.buf = this.buf.slice(nl + 1);
				if (!line) continue;
				const msg = JSON.parse(line); // anything non-JSON on stdout is a bug
				if (typeof msg.id === "number") this.pending.get(msg.id)?.(msg);
			}
		});
		this.proc.stderr.on("data", (c) => (this.stderr += c));
	}

	request(method: string, params: object = {}): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${method} timed out. stderr:\n${this.stderr}`)), 15_000);
			this.pending.set(id, (msg) => {
				clearTimeout(timer);
				this.pending.delete(id);
				resolve(msg);
			});
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: object = {}) {
		this.send({ jsonrpc: "2.0", method, params });
	}

	private send(msg: object) {
		this.proc.stdin.write(JSON.stringify(msg) + "\n");
	}

	close(): Promise<void> {
		return new Promise((resolve) => {
			if (this.proc.exitCode !== null) return resolve();
			this.proc.once("exit", () => resolve());
			this.proc.stdin.end();
			setTimeout(() => this.proc.kill(), 2_000).unref();
		});
	}
}
