// The "test with" matrix entry: one browser engine, device profile, locale and environment the
// person declared. Drivers read it; only the engine's project parser creates one, and nothing
// ever invents or substitutes a target.
import type { Brand } from '../foundation/Brand.ts';

export const Engine = {
  Chromium: 'chromium',
  Firefox: 'firefox',
  Webkit: 'webkit',
} as const;
export type Engine = (typeof Engine)[keyof typeof Engine];
export const ENGINES: readonly Engine[] = Object.values(Engine);

// A closed set of device profiles owned by this package, so no vendor's device list decides
// what a target looks like. Sizes are css pixels.
export const DEVICE_PROFILES = {
  'desktop-1280': { width: 1280, height: 800, scale: 1, mobile: false, touch: false },
  'laptop-1024': { width: 1024, height: 768, scale: 1, mobile: false, touch: false },
  'tablet-820': { width: 820, height: 1180, scale: 2, mobile: true, touch: true },
  'phone-390': { width: 390, height: 844, scale: 3, mobile: true, touch: true },
} as const;
export type DeviceProfileId = keyof typeof DEVICE_PROFILES;
export type DeviceProfile = (typeof DEVICE_PROFILES)[DeviceProfileId];

export const ColorScheme = {
  Light: 'light',
  Dark: 'dark',
} as const;
export type ColorScheme = (typeof ColorScheme)[keyof typeof ColorScheme];
export const COLOR_SCHEMES: readonly ColorScheme[] = Object.values(ColorScheme);
export const MotionPreference = {
  Reduce: 'reduce',
  NoPreference: 'no-preference',
} as const;
export type MotionPreference = (typeof MotionPreference)[keyof typeof MotionPreference];
export const MOTION_PREFERENCES: readonly MotionPreference[] = Object.values(MotionPreference);

export type TargetId = Brand<string, 'TargetId'>;
export type AdapterId = Brand<string, 'AdapterId'>;
// A BCP 47 language tag in canonical form, such as "de-DE".
export type Locale = Brand<string, 'Locale'>;
// An IANA time zone name, such as "Asia/Tokyo".
export type TimeZone = Brand<string, 'TimeZone'>;
// scheme://host[:port], with no path.
export type Origin = Brand<string, 'Origin'>;
// The absolute http or https URL a run's relative paths resolve against, with no user name or
// password in it. Only the engine's base URL decoder makes one.
export type BaseUrl = Brand<string, 'BaseUrl'>;

// How close the target is to what a user holds. engine: the browser engine itself;
// engine-emulated: the engine with a device's viewport and input emulated; emulator and simulator:
// a device emulated or simulated as a whole; real: a real device.
export const Fidelity = {
  Engine: 'engine',
  EngineEmulated: 'engine-emulated',
  Emulator: 'emulator',
  Simulator: 'simulator',
  Real: 'real',
} as const;
export type Fidelity = (typeof Fidelity)[keyof typeof Fidelity];
export const FIDELITIES: readonly Fidelity[] = Object.values(Fidelity);

// A vendor's own setting, keyed "vendor:name" so it can never clash with a core field.
export type VendorExtensionKey = `${string}:${string}`;

export type Target = {
  readonly id: TargetId;
  readonly adapter: AdapterId;
  readonly engine: Engine;
  readonly device: DeviceProfileId;
  readonly locale: Locale;
  readonly timezone: TimeZone;
  readonly colorScheme: ColorScheme;
  readonly reducedMotion: MotionPreference;
  // The fields below are present only when the project file gives them, so the manifests of
  // targets that leave them out stay byte for byte as they were. The engine's target helpers
  // supply the defaults.
  // The browser build the person asks for, such as "156.0.7258.5". Without it, the adapter's own
  // build is used, pinned by the lockfile when there is one.
  readonly version?: string;
  readonly fidelity?: Fidelity;
  // Whether the run fails when this target is unavailable. An optional target is skipped with a warning.
  readonly required?: boolean;
  readonly vendorExtensions?: Readonly<Record<VendorExtensionKey, unknown>>;
};

export const deviceProfile = (target: Target): DeviceProfile => DEVICE_PROFILES[target.device];
