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

export type Target = {
  readonly id: TargetId;
  readonly adapter: AdapterId;
  readonly engine: Engine;
  readonly device: DeviceProfileId;
  readonly locale: Locale;
  readonly timezone: TimeZone;
  readonly colorScheme: ColorScheme;
  readonly reducedMotion: MotionPreference;
};

export const deviceProfile = (target: Target): DeviceProfile => DEVICE_PROFILES[target.device];
