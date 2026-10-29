// What a report says a run was tested on, built only from the target and the build that ran it.
// The wording names what was really there: an emulated phone viewport is never "a phone", and
// Playwright's patched WebKit is never "Safari". See docs/specs/SPEC-05-target-matrix-and-lock.md.
import type { BrowserBuild, DeviceProfileId, Engine, Fidelity, Target } from '@revisum/contracts';
import { targetFidelity } from './target-defaults.ts';

const ENGINE_WORDING: { readonly [Name in Engine]: (major: string) => string } = {
  chromium: (major) => `Chromium${major}`,
  firefox: (major) => `Firefox${major}`,
  // WebKit builds that test tools ship carry their own patches, so they are not the Safari users run.
  webkit: (major) => `patched WebKit${major}, not Safari`,
};

const DEVICE_WORDING: { readonly [Profile in DeviceProfileId]: string } = {
  'desktop-1280': 'desktop viewport',
  'laptop-1024': 'laptop viewport',
  'tablet-820': 'tablet viewport',
  'phone-390': 'phone viewport',
};

// The engine itself needs no note; anything else says how it stands in for a device.
const FIDELITY_NOTE: { readonly [Level in Fidelity]: string | null } = {
  'engine': null,
  'engine-emulated': 'emulated',
  'emulator': 'device emulator',
  'simulator': 'device simulator',
  'real': 'real device',
};

// The major version, the leading number of a build such as 156.0.7258.5, or nothing when no
// version is known.
function majorVersion(target: Target, build: BrowserBuild | undefined): string {
  const version = build?.version ?? target.version;
  const major = version === undefined ? undefined : /^(\d+)/.exec(version)?.[1];
  return major === undefined ? '' : ` ${major}`;
}

// Such as "Chromium 156, phone viewport (emulated)".
export function testedOn(target: Target, build?: BrowserBuild): string {
  const note = FIDELITY_NOTE[targetFidelity(target)];
  const wording = `${ENGINE_WORDING[target.engine](majorVersion(target, build))}, ${DEVICE_WORDING[target.device]}`;
  return note === null ? wording : `${wording} (${note})`;
}
