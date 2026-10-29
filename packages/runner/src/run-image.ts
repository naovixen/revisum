// Prepares the run image: builds packages/runner/image/Dockerfile from the base image pinned by
// digest in .devcontainer/devcontainer.json, and records the built image's id beside the
// Dockerfile's hash and the base image in a file Git ignores. The image is rebuilt only when the
// Dockerfile or the base image changed, or the recorded image is gone. A run is then started with
// that id, and refused when the local image no longer has it.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import { PRODUCT, failure, success, type ImageDigest, type Result } from '@revisum/contracts';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDocker } from './container-engine.ts';

// The local tag of the run image. A run is pinned by the image's id, never by this tag.
export const RUN_IMAGE_TAG = `${PRODUCT.name}-run`;
export const RUN_IMAGE_RECORD = `.${PRODUCT.name}-run-image.json`;
const IMAGE_FOLDER = join('packages', 'runner', 'image');
const DEV_CONTAINER_FILE = join('.devcontainer', 'devcontainer.json');
const BUILD_TIMEOUT_MILLISECONDS = 1_200_000;

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const PINNED_BASE_IMAGE = /"image"\s*:\s*"([^"\s]+@sha256:[0-9a-f]{64})"/;

// What the record file holds, and what the run manifest can record about the image.
export type RunImage = {
  readonly id: ImageDigest;
  readonly baseImage: string;
  readonly dockerfileSha256: string;
};

export type RunImageError = {
  readonly code: 'base-image-unpinned' | 'docker-unavailable' | 'build-failed';
  readonly detail: string;
};

// The one place an image id read from Docker becomes an ImageDigest: "sha256:" and 64 hex digits.
export function readImageDigest(text: string): ImageDigest | null {
  return IMAGE_ID.test(text) ? text as ImageDigest : null;
}

// The record file's content, or null when it is missing or not what this module writes.
function readRecord(path: string): RunImage | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const id = Reflect.get(parsed, 'id');
  const baseImage = Reflect.get(parsed, 'baseImage');
  const dockerfileSha256 = Reflect.get(parsed, 'dockerfileSha256');
  if (typeof id !== 'string' || typeof baseImage !== 'string' || typeof dockerfileSha256 !== 'string') return null;
  const digest = readImageDigest(id);
  return digest === null ? null : { id: digest, baseImage, dockerfileSha256 };
}

export async function prepareRunImage(options: { readonly repositoryRoot: string }): Promise<Result<RunImage, RunImageError>> {
  const root = options.repositoryRoot;
  const pinned = PINNED_BASE_IMAGE.exec(readFileSync(join(root, DEV_CONTAINER_FILE), 'utf8'))?.[1];
  if (pinned === undefined) return failure({ code: 'base-image-unpinned', detail: `${DEV_CONTAINER_FILE} names no image pinned by digest` });
  const dockerfile = join(root, IMAGE_FOLDER, 'Dockerfile');
  const dockerfileSha256 = createHash('sha256').update(readFileSync(dockerfile)).digest('hex');
  const recordPath = join(root, RUN_IMAGE_RECORD);

  const inspected = await runDocker(['image', 'inspect', '--format', '{{.Id}}', RUN_IMAGE_TAG]);
  const current = inspected.status === 0 ? readImageDigest(inspected.stdout.trim()) : null;
  const recorded = readRecord(recordPath);
  if (current !== null && recorded !== null && recorded.id === current && recorded.dockerfileSha256 === dockerfileSha256 && recorded.baseImage === pinned) {
    return success(recorded);
  }

  const version = await runDocker(['version', '--format', '{{.Server.Version}}']);
  if (version.status !== 0) return failure({ code: 'docker-unavailable', detail: version.stderr.trim().slice(0, 500) });
  const built = await runDocker([
    'build', '--tag', RUN_IMAGE_TAG, '--build-arg', `BASE_IMAGE=${pinned}`, '--file', dockerfile, join(root, IMAGE_FOLDER),
  ], BUILD_TIMEOUT_MILLISECONDS);
  if (built.status !== 0) return failure({ code: 'build-failed', detail: built.stderr.trim().slice(-2000) });
  const rebuilt = await runDocker(['image', 'inspect', '--format', '{{.Id}}', RUN_IMAGE_TAG]);
  const id = readImageDigest(rebuilt.stdout.trim());
  if (rebuilt.status !== 0 || id === null) return failure({ code: 'build-failed', detail: `the built image has no id: ${rebuilt.stderr.trim()}` });
  const image: RunImage = { id, baseImage: pinned, dockerfileSha256 };
  writeFileSync(recordPath, `${JSON.stringify(image, null, 2)}\n`);
  return success(image);
}
