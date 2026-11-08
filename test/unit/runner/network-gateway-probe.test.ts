// What the isolation probe tries, and what its answer means, on a fake container engine. On an
// --internal network a kept gateway would let a run reach the Docker host, so both runners probe where
// the gateway would be as well as public addresses:
//   - when a container on the network holds the subnet's first address, Docker gave it out because
//     there is no gateway, so that address is skipped;
//   - otherwise it is tried on port 80, where a refused connection counts as reached, since a kept
//     gateway refuses unused ports;
//   - a network that cannot be read counts as reached, so an unknown is never taken for blocked.
// Reached means the isolated runner stays at the host level and logs egress-unenforceable, and the
// workload runner refuses with egress-unenforceable before the team's image starts. Not reached
// means isolated, and the team's image starts. The fake probe answers as the real one does: a
// target answers only if a machine is listening there or refuses and the target counts that.
// What Docker's description of a network gives networkGatewayAddress is in
// docker-network-description.test.ts.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { failure, success, type Result } from '@revisum/contracts';
import { dockerRunner, type ContainerEngine, type EngineProblem, type ProbeTarget, type RunnerLogEntry } from '@revisum/runner';
import { REPOSITORY_ROOT } from '../../support/repository.ts';
import { fakeContainerEngine, type FakeContainerEngine } from './fake-container-engine.ts';
import { egressPolicy, imageDigest, PINNED_IMAGE_ID } from './runner-examples.ts';
import { PRESENT_IMAGES, errorCode, runnerOn, teamContainers, workloadRequest } from './workload-examples.ts';

const FIRST_ADDRESS = '172.18.0.1';
const PUBLIC_ADDRESS = '1.1.1.1';

// What the run's network is like, as the fake engine answers for it.
type NetworkWorld = {
  // What networkGatewayAddress answers; absent for the fake's own answer, an address to try.
  readonly gateway?: Result<string | null, EngineProblem>;
  // Hosts where a machine accepts every connection.
  readonly listening?: readonly string[];
  // Hosts where a machine refuses connections, as a kept gateway does on an unused port.
  readonly refusing?: readonly string[];
};

// A world with the gateway gone and Docker's first address held by a container.
const HELD_BY_A_CONTAINER: NetworkWorld = { gateway: success(null), refusing: [FIRST_ADDRESS] };

type ProbeRecord = {
  readonly engine: FakeContainerEngine;
  readonly gatewayAskedAbout: readonly string[];
  readonly probes: readonly (readonly ProbeTarget[])[];
};

function engineIn(world: NetworkWorld): { readonly engine: FakeContainerEngine & ContainerEngine; readonly record: ProbeRecord } {
  const fake = fakeContainerEngine({ localImageId: PINNED_IMAGE_ID, internalNetworks: true, probe: 'blocked', images: PRESENT_IMAGES });
  const gatewayAskedAbout: string[] = [];
  const probes: (readonly ProbeTarget[])[] = [];
  const answersThere = (target: ProbeTarget): boolean =>
    (world.listening ?? []).includes(target.host) || (target.refusalCountsAsReached === true && (world.refusing ?? []).includes(target.host));
  const answer = world.gateway;
  const engine = {
    ...fake,
    ...(answer === undefined ? {} : {
      networkGatewayAddress: async (network: string) => {
        gatewayAskedAbout.push(network);
        return answer;
      },
    }),
    probeEgress: async (_containerId: string, targets: readonly ProbeTarget[]) => {
      probes.push(targets);
      return targets.some(answersThere) ? 'reached' as const : 'blocked' as const;
    },
  };
  return { engine, record: { engine, gatewayAskedAbout, probes } };
}

// ---- Each runner, reduced to what the rules say about it ---------------------------------------------

type Finding = {
  readonly record: ProbeRecord;
  // Whether the runner took egress as enforced.
  readonly enforced: boolean;
  readonly loggedUnenforceable: boolean;
};

async function throughIsolatedRunner(world: NetworkWorld): Promise<Finding> {
  const { engine, record } = engineIn(world);
  const logged: RunnerLogEntry[] = [];
  const runner = dockerRunner({ engine, repositoryRoot: REPOSITORY_ROOT, log: (entry) => { logged.push(entry); } });
  const levels: string[] = [];
  const started = await runner.withRun(imageDigest(PINNED_IMAGE_ID), egressPolicy({ allowOrigins: [] }), (run) => {
    levels.push(run.guaranteeLevel());
    return Promise.resolve();
  });
  assert.ok(started.ok, `a plan run still starts, at whichever level: ${JSON.stringify(started)}`);
  return { record, enforced: levels[0] === 'isolated', loggedUnenforceable: logged.some((entry) => entry.code === 'egress-unenforceable') };
}

const outputFolders: string[] = [];
after(() => { for (const folder of outputFolders.splice(0)) {rmSync(folder, { recursive: true, force: true });} });

async function throughWorkloadRunner(world: NetworkWorld): Promise<Finding> {
  const { engine, record } = engineIn(world);
  const { runner, logged } = runnerOn(engine);
  const outputDirectory = mkdtempSync(join(tmpdir(), 'gateway-probe-output-'));
  outputFolders.push(outputDirectory);
  const outcome = await runner.run(workloadRequest({ outputDirectory }));
  const refused = errorCode(outcome) === 'egress-unenforceable';
  // The refusal and whether the team's image started must agree, whichever the rules give.
  assert.equal(teamContainers(engine.started).length, refused ? 0 : 1, JSON.stringify(outcome));
  return { record, enforced: !refused, loggedUnenforceable: logged.some((entry) => entry.code === 'egress-unenforceable') };
}

const RUNNERS: readonly { readonly title: string; readonly probeIn: (world: NetworkWorld) => Promise<Finding> }[] = [
  { title: 'the isolated runner', probeIn: throughIsolatedRunner },
  { title: 'the workload runner', probeIn: throughWorkloadRunner },
];

const assertEnforced = (finding: Finding): void => {
  assert.equal(finding.enforced, true, 'the runner took egress as not enforced');
  assert.equal(finding.loggedUnenforceable, false, 'the runner logged egress-unenforceable');
};
const assertUnenforceable = (finding: Finding): void => {
  assert.equal(finding.enforced, false, 'the runner took egress as enforced');
  assert.equal(finding.loggedUnenforceable, true, 'the runner did not log egress-unenforceable');
};

const targetsTried = (finding: Finding): readonly ProbeTarget[] => finding.record.probes.flat();

// ---- The rules, for each runner -------------------------------------------------------------------------

for (const { title, probeIn } of RUNNERS) {
  test(`${title} skips the subnet's first address when a container on the network holds it`, async () => {
    const finding = await probeIn(HELD_BY_A_CONTAINER);
    assert.ok(!targetsTried(finding).some((target) => target.host === FIRST_ADDRESS), JSON.stringify(targetsTried(finding)));
    assertEnforced(finding);
  });

  test(`${title} still tries public addresses when a container holds the first address`, async () => {
    const finding = await probeIn({ ...HELD_BY_A_CONTAINER, listening: [PUBLIC_ADDRESS] });
    assert.ok(targetsTried(finding).some((target) => target.host === PUBLIC_ADDRESS), JSON.stringify(targetsTried(finding)));
    assertUnenforceable(finding);
  });

  test(`${title} tries the first address on port 80 when no container holds it, counting a refusal as reached`, async () => {
    const finding = await probeIn({ gateway: success(FIRST_ADDRESS) });
    assert.deepEqual(
      targetsTried(finding).filter((target) => target.host === FIRST_ADDRESS),
      [{ host: FIRST_ADDRESS, port: 80, refusalCountsAsReached: true }],
    );
  });

  test(`${title} still tries public addresses beside the first address, without counting a refusal there`, async () => {
    const finding = await probeIn({ gateway: success(FIRST_ADDRESS), refusing: [PUBLIC_ADDRESS] });
    const publicTarget = targetsTried(finding).find((target) => target.host === PUBLIC_ADDRESS);
    assert.ok(publicTarget !== undefined, JSON.stringify(targetsTried(finding)));
    assert.notEqual(publicTarget.refusalCountsAsReached, true);
    assertEnforced(finding);
  });

  test(`${title} treats a gateway that refuses the connection as reached`, async () => {
    assertUnenforceable(await probeIn({ gateway: success(FIRST_ADDRESS), refusing: [FIRST_ADDRESS] }));
  });

  test(`${title} treats a gateway that accepts the connection as reached`, async () => {
    assertUnenforceable(await probeIn({ gateway: success(FIRST_ADDRESS), listening: [FIRST_ADDRESS] }));
  });

  test(`counter-example: ${title} takes egress as enforced when nothing answers at the first address`, async () => {
    assertEnforced(await probeIn({ gateway: success(FIRST_ADDRESS) }));
  });

  test(`${title} treats a network it cannot read as reached, whatever a probe would find`, async () => {
    assertUnenforceable(await probeIn({ gateway: failure({ detail: 'no such network' }) }));
  });

  test(`${title} asks about the run's own network`, async () => {
    const finding = await probeIn(HELD_BY_A_CONTAINER);
    const internal = finding.record.engine.createdNetworks.filter((network) => network.internal).map((network) => network.name);
    assert.equal(internal.length, 1, JSON.stringify(finding.record.engine.createdNetworks));
    assert.deepEqual(finding.record.gatewayAskedAbout, internal);
  });

  test(`counter-example: ${title}, with the fake's own gateway address and nothing answering there, goes by the public addresses`, async () => {
    assertEnforced(await probeIn({}));
    assertUnenforceable(await probeIn({ listening: [PUBLIC_ADDRESS] }));
  });
}

// ---- What the level says, for the isolated runner, which has one ------------------------------------------

test('reached leaves the isolated runner at the host level, and not reached gives isolated', async () => {
  const levelIn = async (world: NetworkWorld): Promise<string> => {
    const { engine } = engineIn(world);
    const runner = dockerRunner({ engine, repositoryRoot: REPOSITORY_ROOT });
    const levels: string[] = [];
    const started = await runner.withRun(imageDigest(PINNED_IMAGE_ID), egressPolicy({ allowOrigins: [] }), (run) => {
      levels.push(run.guaranteeLevel());
      return Promise.resolve();
    });
    assert.ok(started.ok, JSON.stringify(started));
    return levels[0] ?? '';
  };
  assert.equal(await levelIn({ gateway: success(FIRST_ADDRESS), refusing: [FIRST_ADDRESS] }), 'host');
  assert.equal(await levelIn({ gateway: failure({ detail: 'no such network' }) }), 'host');
  assert.equal(await levelIn(HELD_BY_A_CONTAINER), 'isolated');
  assert.equal(await levelIn({ gateway: success(FIRST_ADDRESS) }), 'isolated');
});
