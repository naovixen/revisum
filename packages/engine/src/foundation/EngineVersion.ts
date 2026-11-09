// The engine's version and the schema ids it writes. Schema ids are built from the product name
// in PRODUCT, so a rename changes them in one place.
import { PRODUCT } from '@revisum/contracts';

export const ENGINE_VERSION = '0.1.0';

export const schemaId = (kind: string, major: number): string => `${PRODUCT.schemaNamespace}.${kind}/v${major}`;
