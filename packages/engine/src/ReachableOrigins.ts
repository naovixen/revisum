// Which of the project's production origins a cleared run may reach. Production is closed to every
// run unless the plan is approved and the project's policy allows production for approved plans.
import type { BaseUrl } from "@revisum/contracts";
import { visitSteps } from "./plan/VisitSteps.ts";
import type { ClearedRun } from "./policy/ClearedRun.ts";
import { isProductionAllowed } from "./policy/IsProductionAllowed.ts";
import { declaredCommands } from "./project/unsafe-feature-declarations.ts";

// The origins of the services the plan's calls and database commands reach, its cleanup included.
function serviceOrigins({ plan, project }: ClearedRun): string[] {
    const steps = [...plan.steps, ...(plan.cleanup ?? [])];
    const commands = declaredCommands(project.unsafeFeatures);
    return steps.flatMap((step) => {
        let serviceName: string | undefined;
        if (step.type === "call" || step.type === "expectBackend") {
            serviceName = Object.entries(project.calls).find(([name]) => name === step.call)?.[1]
                .service;
        } else if (step.type === "database" || step.type === "expectDatabase") {
            serviceName = Object.entries(commands).find(([name]) => name === step.command)?.[1]
                .service;
        }
        const service = project.services.find((candidate) => candidate.name === serviceName);
        return service === undefined ? [] : [service.origin];
    });
}

// The first production origin the run would reach: its base URL, a navigate step or a second tab's
// URL, inside frames and second tabs too, or a declared call's service.
export function productionOriginReached(cleared: ClearedRun, baseUrl: BaseUrl): string | undefined {
    const production = new Set<string>(cleared.project.productionOrigins);
    if (production.size === 0) {
        return undefined;
    }
    const origins = [new URL(baseUrl).origin];
    visitSteps(cleared.plan.steps, (step) => {
        // A path template always stays on the base URL's origin, already in the list.
        if ((step.type === "navigate" || step.type === "newTab") && typeof step.url === "string") {
            origins.push(new URL(step.url, baseUrl).origin);
        }
    });
    origins.push(...serviceOrigins(cleared));
    return origins.find((origin) => production.has(origin));
}

// The origins the browser may reach. A run that may not reach production has the production origins
// left out of its allow-list as well, so any request the page makes to one is blocked.
export function reachableOrigins(cleared: ClearedRun): readonly string[] {
    if (isProductionAllowed(cleared.standing, cleared.project.policy)) {
        return cleared.project.origins;
    }
    const production = new Set<string>(cleared.project.productionOrigins);
    return cleared.project.origins.filter((origin) => !production.has(origin));
}
