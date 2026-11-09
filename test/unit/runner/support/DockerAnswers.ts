// Stands in for the Docker client: replacing spawn on the module's CommonJS exports and syncing the
// built-in ES module bindings reaches the engine's own import. Restore it after each test.
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";

const realSpawn: unknown = Reflect.get(childProcess, "spawn");

export const restoreDockerClient = (): void => {
    Reflect.set(childProcess, "spawn", realSpawn);
    syncBuiltinESMExports();
};

export type DockerAnswer = {
    readonly status: number;
    readonly stdout?: string;
    readonly stderr?: string;
};

export const replaceSpawn = (answerWith: () => unknown): void => {
    Reflect.set(childProcess, "spawn", answerWith);
    syncBuiltinESMExports();
};

export function dockerAnswers(answer: DockerAnswer): void {
    replaceSpawn(() => {
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: () => true });
        setImmediate(() => {
            stdout.emit("data", Buffer.from(answer.stdout ?? "", "utf8"));
            stderr.emit("data", Buffer.from(answer.stderr ?? "", "utf8"));
            child.emit("close", answer.status);
        });
        return child;
    });
}
