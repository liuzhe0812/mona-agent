const ASSET_PREFIX = import.meta.env.BASE_URL === "/work/" ? "/work" : "";

export const MONA_BRAND_ICON = `${ASSET_PREFIX}/brand/mona_app_icon.png?v=a829e97b8751`;
export const MONA_PROVIDER_ICON = `${ASSET_PREFIX}/brand/mona_icon.png?v=a829e97b8751`;
export const MONA_BRAND_AVATAR = `${ASSET_PREFIX}/brand/mona-default-avatar.png?v=3932b58cd98c`;
export const MONA_BRAND_HUMAN = `${ASSET_PREFIX}/brand/v2/human-master.webp`;
export const MONA_COMPOSER_COMPANION = `${ASSET_PREFIX}/brand/v2/composer-human-chibi-left.png`;
export const MONA_COMPOSER_RESTING = `${ASSET_PREFIX}/brand/v2/composer-human-chibi-resting.png`;

const LEGACY_MONA_AVATARS = ["/brand/mona_avatar_human.png", "/brand/v2/avatar.webp"];

export function resolveMonaAvatarUrl(avatarUrl?: string | null): string {
  return !avatarUrl || LEGACY_MONA_AVATARS.includes(avatarUrl.split(/[?#]/, 1)[0])
    ? MONA_BRAND_AVATAR
    : avatarUrl;
}
