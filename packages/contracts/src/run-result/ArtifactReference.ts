// A file a run stored, by name, media type, hash and size.
export type ArtifactReference = {
    readonly name: string;
    readonly mediaType: string;
    readonly sha256: string;
    readonly bytes: number;
};
