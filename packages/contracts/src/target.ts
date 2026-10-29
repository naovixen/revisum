// The "test with" matrix entry: one browser engine, device profile, locale and environment the
// person declared. Drivers read it; only the engine's project parser creates one, and nothing
// ever invents or substitutes a target.
import type { Brand } from './brand.ts';

export const ENGINES = ['chromium', 'firefox', 'webkit'] as const;
export type Engine = (typeof ENGINES)[number];

// A closed set of device profiles owned by this package, so no vendor's device list decides
// what a target looks like. Sizes are CSS pixels.
export const DEVICE_PROFILES = {
  'desktop-1280': { width: 1280, height: 800, scale: 1, mobile: false, touch: false },
  'laptop-1024': { width: 1024, height: 768, scale: 1, mobile: false, touch: false },
  'tablet-820': { width: 820, height: 1180, scale: 2, mobile: true, touch: true },
  'phone-390': { width: 390, height: 844, scale: 3, mobile: true, touch: true },
} as const;
export type DeviceProfileId = keyof typeof DEVICE_PROFILES;
export type DeviceProfile = (typeof DEVICE_PROFILES)[DeviceProfileId];

export const COLOR_SCHEMES = ['light', 'dark'] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];
export const MOTION_PREFERENCES = ['reduce', 'no-preference'] as const;
export type MotionPreference = (typeof MOTION_PREFERENCES)[number];

export type TargetId = Brand<string, 'TargetId'>;
export type AdapterId = Brand<string, 'AdapterId'>;
// A BCP 47 language tag in canonical form, such as "de-DE".
export type Locale = Brand<string, 'Locale'>;
// An IANA time zone name, such as "Asia/Tokyo".
export type TimeZone = Brand<string, 'TimeZone'>;
// scheme://host[:port], with no path.
export type Origin = Brand<string, 'Origin'>;

// What kind of thing the target runs the app in. Only browsers run today; the others are declared
// so a matrix can name them and get an honest "unavailable" rather than a stand-in.
export const TARGET_KINDS = ['browser', 'mobile-web', 'native-app', 'desktop'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

// How close the target is to what a user holds. engine: the browser engine itself;
// engine-emulated: the engine with a device's viewport and input emulated; emulator and simulator:
// a device emulated or simulated as a whole; real: a real device.
export const FIDELITIES = ['engine', 'engine-emulated', 'emulator', 'simulator', 'real'] as const;
export type Fidelity = (typeof FIDELITIES)[number];

// Where the browser or device comes from.
export const TARGET_PROVIDERS = ['local', 'emulator', 'cloud', 'bridge'] as const;
export type TargetProvider = (typeof TARGET_PROVIDERS)[number];

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
  readonly kind?: TargetKind;
  // The browser build the person asks for, such as "156.0.7258.5". Without it, the adapter's own
  // build is used, pinned by the lockfile when there is one.
  readonly version?: string;
  readonly fidelity?: Fidelity;
  readonly provider?: TargetProvider;
  // Whether the run fails when this target is unavailable. An optional target is skipped with a warning.
  readonly required?: boolean;
  readonly vendorExtensions?: Readonly<Record<VendorExtensionKey, unknown>>;
};

export const deviceProfile = (target: Target): DeviceProfile => DEVICE_PROFILES[target.device];
