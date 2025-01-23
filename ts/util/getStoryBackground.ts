// Copyright 2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { AttachmentType, TextAttachmentType } from '../types/Attachment';

export const COLOR_BLACK_ALPHA_90 = 'rgba(0, 0, 0, 0.9)';
export const COLOR_BLACK_INT = 4278190080;
export const COLOR_WHITE_INT = 4294704123;

export function getHexFromNumber(color: number): string {
  return `#${color.toString(16).slice(2)}`;
}

export function getBackgroundColor({
  color,
  gradient,
}: Pick<TextAttachmentType, 'color' | 'gradient'>): string {
  if (
    gradient?.colors?.length &&
    gradient?.colors.length === gradient?.positions?.length
  ) {
    const values = [`${gradient.angle}deg`];
    for (const [i, step] of gradient.colors.entries()) {
      const position = gradient.positions[i] ?? 1;
      const stepHex = getHexFromNumber(step || COLOR_WHITE_INT);
      if (position == null) {
        values.push(stepHex);
      } else {
        values.push(`${stepHex} ${position * 100}%`);
      }
    }

    return `linear-gradient(${values.join(', ')}) border-box`;
  }

  if (gradient) {
    return `linear-gradient(${gradient.angle}deg, ${getHexFromNumber(
      gradient.startColor || COLOR_WHITE_INT
    )}, ${getHexFromNumber(gradient.endColor || COLOR_WHITE_INT)}) border-box`;
  }

  return getHexFromNumber(color || COLOR_WHITE_INT);
}

export function getStoryBackground(attachment?: AttachmentType): string {
  if (!attachment) {
    return COLOR_BLACK_ALPHA_90;
  }

  if (attachment.textAttachment) {
    return getBackgroundColor(attachment.textAttachment);
  }

  if (attachment.screenshot && attachment.screenshot.url) {
    return `url("${attachment.screenshot.url}")`;
  }

  if (attachment.url) {
    return `url("${attachment.url}")`;
  }

  return COLOR_BLACK_ALPHA_90;
}
