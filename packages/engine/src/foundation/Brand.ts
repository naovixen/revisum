// The one place a brand is applied. Only the engine's parsers call this, after they have checked
// the value, so a branded type always means "validated by its owning parser".
import type { Brand } from '@revisum/contracts';

export const brand = <Value, Name extends string>(value: Value): Brand<Value, Name> => value as Brand<Value, Name>;
