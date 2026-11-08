// A container of the team's own image: never root, under the pinned seccomp profile, with Revisum's
// keep-alive as its main process, so the image's own entrypoint never runs.
import { join } from "node:path";
import type { ContainerOptions } from "../container-engine.ts";
import { SECCOMP_PROFILE } from "../run-containers.ts";

// The uid and gid used when the image's own user is root, or the image names none.
const UNPRIVILEGED_USER = "1000:1000";

const isRoot = (user: string): boolean => /^(root|0)(:|$)/.test(user.trim());

const containerUser = (imageUser: string | null): string =>
    imageUser === null || isRoot(imageUser) ? UNPRIVILEGED_USER : imageUser;

type TeamContainerFields = Omit<
    ContainerOptions,
    "user" | "seccompProfile" | "entrypoint" | "command"
>;

export const teamImageContainer = (
    root: string,
    imageUser: string | null,
    fields: TeamContainerFields,
): ContainerOptions => ({
    ...fields,
    user: containerUser(imageUser),
    seccompProfile: join(root, SECCOMP_PROFILE),
    entrypoint: "sleep",
    command: ["infinity"],
});
