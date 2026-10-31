// Wires the engine's DatabaseCommandRunner port to runner's workload runner: the one place they
// meet for database commands, so the engine never imports runner. Each command runs in the team's
// image, from the top of the checkout, with an output folder of its own that is removed afterwards.
// The request's policy allows only the command's service over TCP; the declared services give the
// runner that service's address and port. No proxy variable is set, since the command speaks TCP.
// The engine judges the reply itself.
// See docs/specs/SPEC-36-unsafe-plan-features.md ("Database commands" under "Milestone").
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PRODUCT,
  type DatabaseCommandRequest, type DatabaseCommandRunner, type DeclaredService, type Result, type WorkloadErrorCode, type WorkloadOutcome,
  type WorkloadRunner,
} from '@revisum/engine';

export type DatabaseCommandRunnerOptions = {
  readonly workload: WorkloadRunner;
  // The trusted project's declared services.
  readonly services: readonly DeclaredService[];
};

export function databaseCommandRunner(options: DatabaseCommandRunnerOptions): DatabaseCommandRunner {
  return {
    async run(request: DatabaseCommandRequest): Promise<Result<WorkloadOutcome, WorkloadErrorCode>> {
      // Only the services the policy names travel with the request: the runner relays no other.
      const services = options.services.filter((service) => request.policy.allowTcpServices.includes(service.name));
      const outputDirectory = mkdtempSync(join(tmpdir(), `${PRODUCT.name}-database-command-`));
      try {
        return await options.workload.run({
          image: request.image, argv: request.argv, workingDirectory: '.', environment: request.environment, policy: request.policy,
          timeoutMilliseconds: request.timeoutMilliseconds, outputDirectory, services, httpProxyVariables: false,
          maximumOutputBytes: request.maximumOutputBytes,
        });
      } finally {
        rmSync(outputDirectory, { recursive: true, force: true });
      }
    },
  };
}
