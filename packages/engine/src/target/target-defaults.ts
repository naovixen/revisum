// The values of a target's optional fields, with the defaults a target that leaves them out gets.
// The project parser keeps absent fields absent, so manifests hold only what the person wrote;
// code that needs a value reads it here. See docs/specs/SPEC-05-target-matrix-and-lock.md.
import { deviceProfile, type Fidelity, type Target, type TargetKind, type TargetProvider } from '@revisum/contracts';

export const targetKind = (target: Target): TargetKind => target.kind ?? 'browser';
export const targetProvider = (target: Target): TargetProvider => target.provider ?? 'local';
// A target is required unless the person says otherwise, so an unavailable one fails the run.
export const isRequiredTarget = (target: Target): boolean => target.required ?? true;

// A desktop or laptop profile runs the engine as it is; a tablet or phone profile emulates the
// device's viewport and touch input in that engine, which is not the device itself.
export const targetFidelity = (target: Target): Fidelity =>
  target.fidelity ?? (deviceProfile(target).mobile ? 'engine-emulated' : 'engine');
