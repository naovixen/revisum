// Why a runner will not start a container, whichever container it is: the isolated run's, or a workload's.
export const ContainerRefusalCode = {
    ImageMissing: "image-missing",
    ImageDigestMismatch: "image-digest-mismatch",
    EgressUnenforceable: "egress-unenforceable",
} as const;
export type ContainerRefusalCode = (typeof ContainerRefusalCode)[keyof typeof ContainerRefusalCode];
