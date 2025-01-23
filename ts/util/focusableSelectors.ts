// Copyright 2023 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// https://www.npmjs.com/package/focusable-selectors
// https://github.com/KittyGiraudel/focusable-selectors/issues/15

const not = {
  inert: ':not([inert]):not([inert] *)',
  negTabIndex: ':not([tabindex^="-"])',
  disabled: ':not(:disabled)',
};

export const focusableSelectors = [
  `a[href]${not.inert}${not.negTabIndex}`,
  `area[href]${not.inert}${not.negTabIndex}`,
  `input:not([type="hidden"]):not([type="radio"])${not.inert}${not.negTabIndex}${not.disabled}`,
  `input[type="radio"]${not.inert}${not.negTabIndex}${not.disabled}`,
  `select${not.inert}${not.negTabIndex}${not.disabled}`,
  `textarea${not.inert}${not.negTabIndex}${not.disabled}`,
  `button${not.inert}${not.negTabIndex}${not.disabled}`,
  `details${not.inert} > summary:first-of-type${not.negTabIndex}`,
  // Discard until Firefox supports `:has()`
  // See: https://github.com/KittyGiraudel/focusable-selectors/issues/12
  // `details:not(:has(> summary))${not.inert}${not.negTabIndex}`,
  `iframe${not.inert}${not.negTabIndex}`,
  `audio[controls]${not.inert}${not.negTabIndex}`,
  `video[controls]${not.inert}${not.negTabIndex}`,
  `[contenteditable]${not.inert}${not.negTabIndex}`,
  `[tabindex]${not.inert}${not.negTabIndex}`,
];

export const focusableSelector = focusableSelectors.join(', ');

/**
 * Matches the first focusable element within the given element or itself if it
 * is focusable.
 */
export function matchOrQueryFocusable(
  element: HTMLElement | null | undefined
): HTMLElement | null | undefined {
  return element?.matches(focusableSelector)
    ? element
    : element?.querySelector(focusableSelector);
}
