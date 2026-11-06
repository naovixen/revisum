// The secrets a step names in the plan itself, by step type. Every step type has an entry, so a new
// type does not compile until someone says where its secrets are. Those inside a declaration were
// held to the project when it was parsed.
import type {
    CallArgument,
    CallArguments,
    SecretName,
    Step,
    StepByType,
    StepType,
} from "@revisum/contracts";

type FillValue = StepByType["fill"]["value"];

const namesIn = (values: readonly (CallArgument | FillValue)[]): readonly SecretName[] =>
    values.flatMap((value) =>
        typeof value === "object" && "secretName" in value ? [value.secretName] : [],
    );

const none = (): readonly SecretName[] => [];

// A call, a check of one, a stub start and a storage write pass their arguments on, and any may be a
// secret. A page script's or a database command's arguments are JSON values, never a secret.
const inArguments = (step: { readonly arguments?: CallArguments }): readonly SecretName[] =>
    namesIn(Object.values(step.arguments ?? {}));

const SECRETS_NAMED: {
    readonly [Type in StepType]: (step: StepByType[Type]) => readonly SecretName[];
} = {
    navigate: none,
    click: none,
    hover: none,
    fill: (step) => namesIn([step.value]),
    select: none,
    upload: none,
    press: none,
    frame: none,
    dialog: none,
    expect: none,
    expectPage: none,
    a11yAudit: none,
    capture: none,
    remember: none,
    download: none,
    expectDownload: none,
    newTab: none,
    call: inArguments,
    expectBackend: inArguments,
    stub: inArguments,
    resetRequests: none,
    expectRequests: none,
    expectResponse: none,
    setStorage: inArguments,
    removeStorage: none,
    expectStorage: none,
    advanceClock: none,
    expectClipboard: none,
    evaluate: none,
    expectScript: none,
    database: none,
    expectDatabase: none,
};

const secretsNamedByType = <Type extends StepType>(
    type: Type,
    step: StepByType[Type],
): readonly SecretName[] => SECRETS_NAMED[type](step);

// The secrets this one step names, not those of the steps inside it.
export const secretsNamedBy = (step: Step): readonly SecretName[] =>
    secretsNamedByType(step.type, step);
