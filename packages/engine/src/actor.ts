// The one module in core that builds a DerivedActor. Code that records an audit event receives a
// DerivedActor and passes it on; it never builds one, so a caller cannot choose its own actor type.
// The approval verifier (SPEC-02) builds them here from a checked approval proof. The engine's
// public entry point does not export this module, and the lint rejects the DerivedActor brand
// applied anywhere else.
// See docs/specs/SPEC-27-shared-types-and-events.md.
import type { ActorId, ActorType, DerivedActor } from '@revisum/contracts';
import { brand } from './brand.ts';

// For core's own use only, once the actor and its type have been established from evidence.
export const deriveActor = (actor: ActorId, actorType: ActorType): DerivedActor =>
  brand<{ readonly actor: ActorId; readonly actorType: ActorType }, 'DerivedActor'>({ actor, actorType });
