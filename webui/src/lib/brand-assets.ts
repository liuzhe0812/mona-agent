export const MONA_BRAND_ICON = "/brand/mona_app_icon.png?v=a829e97b8751";
export const MONA_PROVIDER_ICON = "/brand/mona_icon.png?v=a829e97b8751";
export const MONA_BRAND_AVATAR = "/brand/mona-default-avatar.png?v=3932b58cd98c";
export const MONA_BRAND_HUMAN = "/brand/v2/human-master.webp";
export const MONA_COMPOSER_COMPANION = "/brand/v2/composer-human-chibi-left.png";
export const MONA_COMPOSER_RESTING = "/brand/v2/composer-human-chibi-resting.png";

const LEGACY_MONA_AVATARS = ["/brand/mona_avatar_human.png", "/brand/v2/avatar.webp"];

export function resolveMonaAvatarUrl(avatarUrl?: string | null): string {
  return !avatarUrl || LEGACY_MONA_AVATARS.includes(avatarUrl.split(/[?#]/, 1)[0])
    ? MONA_BRAND_AVATAR
    : avatarUrl;
}
