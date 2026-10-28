// The one module in core that builds a DerivedActor or an ActorId. Code that records an audit
// event receives a DerivedActor and passes it on; it never builds one, so a caller cannot choose
// its own actor type. The approval verifier (SPEC-02) builds them here from a checked approval
// proof. The engine's public entry point does not export this module, and the lint rejects the
// DerivedActor brand applied anywhere else.
// See docs/specs/SPEC-27-shared-types-and-events.md.
import { createHmac } from 'node:crypto';
import type { ActorId, ActorType, DerivedActor } from '@revisum/contracts';
import { brand } from './brand.ts';

// For core's own use only, once the actor and its type have been established from evidence.
export const deriveActor = (actor: ActorId, actorType: ActorType): DerivedActor =>
  brand<{ readonly actor: ActorId; readonly actorType: ActorType }, 'DerivedActor'>({ actor, actorType });

// A keyed hash (HMAC-SHA256) of an identity, such as a GitHub login, under the customer's key, so
// audit events can tell actors apart without ever holding who they are. Logins are compared
// case-insensitively by GitHub, so they are lowercased first.
export const pseudonymousActorId = (identity: string, key: string): ActorId =>
  brand<string, 'ActorId'>(createHmac('sha256', key).update(identity.toLowerCase(), 'utf8').digest('hex'));

// The id for an actor whose person is unknown, such as a local decision with no proof or the
// author of the change under test. It names only where the action came from, so every such
// actor from one source shares it, and none can pass as a particular person.
export const sourceActorId = (source: string): ActorId =>
  brand<string, 'ActorId'>(createHmac('sha256', 'unattributed source').update(source, 'utf8').digest('hex'));
