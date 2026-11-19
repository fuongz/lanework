// A project's chosen avatar (FE-162): an icon, an emoji or a letter, on a
// colour from a fixed palette. Synced with the project: the local store keeps
// it for a local project, the service for a cloud one.
//
// NOTE: The shape, the palette, the curated icons and the parser come from
// @lanework/contracts (BE-01 on board lanework.dev/contracts, 0.5.0), the
// same ones the server validates with. Never fork them here: an icon the
// desktop offers but the contract refuses is a 400 from the service.
//
// NOTE: Colours are ids, never hex: the user decided there are no custom
// colours (2026-11-19). Each app draws an id its own way.

import { PROJECT_AVATAR_COLORS } from "@lanework/contracts";

export {
  PROJECT_AVATAR_COLORS,
  PROJECT_AVATAR_ICONS,
  type ProjectAvatar,
  type ProjectAvatarColor,
  type ProjectAvatarIcon,
  parseProjectAvatar,
} from "@lanework/contracts";

/** Plain colours: the palette's first ten ids. */
export const PROJECT_AVATAR_SOLIDS = PROJECT_AVATAR_COLORS.slice(0, 10);

/** Two-colour gradients: the palette's last six ids. */
export const PROJECT_AVATAR_GRADIENTS = PROJECT_AVATAR_COLORS.slice(10);
