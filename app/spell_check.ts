// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { BrowserWindow } from 'electron';
import { Menu, clipboard, nativeImage } from 'electron';
import { fileURLToPath } from 'url';
import * as LocaleMatcher from '@formatjs/intl-localematcher';

import { maybeParseUrl } from '../ts/util/url';

import type { MenuListType } from '../ts/types/menu';
import type { LocalizerType } from '../ts/types/Util';
import { strictAssert } from '../ts/util/assert';

export const FAKE_DEFAULT_LOCALE = 'en-x-ignore'; // -x- is an extension space for attaching other metadata to the locale

strictAssert(
  new Intl.Locale(FAKE_DEFAULT_LOCALE).toString() === FAKE_DEFAULT_LOCALE,
  "Ensure Intl doesn't change our fake locale ever"
);

export function getLanguages(
  preferredSystemLocales: ReadonlyArray<string>,
  availableLocales: ReadonlyArray<string>,
  defaultLocale: string
): Array<string> {
  const matchedLocales = [];

  preferredSystemLocales.forEach(preferredSystemLocale => {
    const matchedLocale = LocaleMatcher.match(
      [preferredSystemLocale],
      availableLocales as Array<string>, // bad types
      // We don't want to fallback to the default locale right away in case we might
      // match some other locales first.
      //
      // However, we do want to match the default locale in case the user's locales
      // actually matches it.
      //
      // This fake locale allows us to reliably filter it out within the loop.
      FAKE_DEFAULT_LOCALE,
      { algorithm: 'best fit' }
    );
    if (matchedLocale !== FAKE_DEFAULT_LOCALE) {
      matchedLocales.push(matchedLocale);
    }
  });

  if (matchedLocales.length === 0) {
    matchedLocales.push(defaultLocale);
  }

  return matchedLocales;
}

export const setup = (
  browserWindow: BrowserWindow,
  preferredSystemLocales: ReadonlyArray<string>,
  i18n: LocalizerType
): void => {
  const { session } = browserWindow.webContents;
  const availableLocales = session.availableSpellCheckerLanguages;
  const languages = getLanguages(
    preferredSystemLocales,
    availableLocales,
    'en'
  );
  console.log('spellcheck: user locales:', preferredSystemLocales);
  console.log(
    'spellcheck: available spellchecker languages:',
    availableLocales
  );
  console.log('spellcheck: setting languages to:', languages);
  session.setSpellCheckerLanguages(languages);

  browserWindow.webContents.on('context-menu',(_event, params) => {
    const { editFlags } = params;
    const isMisspelled = Boolean(params.misspelledWord);
    const isLink = Boolean(params.linkURL);
    const isImage =
      params.mediaType === 'image' && params.hasImageContents && params.srcURL;
    const showMenu =
      params.isEditable || editFlags.canCopy || isLink || isImage;

    // Popup editor menu
    if (showMenu) {
      const template: MenuListType = [];

      if (isMisspelled) {
        if (params.dictionarySuggestions.length > 0) {
          template.push(
            ...params.dictionarySuggestions.map(label => ({
              label,
              click: () => {
                browserWindow.webContents.replaceMisspelling(label);
              },
            }))
          );
        } else {
          template.push({
            label: i18n('icu:contextMenuNoSuggestions'),
            enabled: false,
          });
        }
        template.push({ type: 'separator' });
      }

      if (params.isEditable) {
        if (editFlags.canUndo) {
          template.push({ label: i18n('icu:editMenuUndo'), role: 'undo' });
        }
        // This is only ever `true` if undo was triggered via the context menu
        // (not ctrl/cmd+z)
        if (editFlags.canRedo) {
          template.push({ label: i18n('icu:editMenuRedo'), role: 'redo' });
        }
        if (editFlags.canUndo || editFlags.canRedo) {
          template.push({ type: 'separator' });
        }
        if (editFlags.canCut) {
          template.push({ label: i18n('icu:editMenuCut'), role: 'cut' });
        }
      }

      if (editFlags.canCopy || isLink || isImage) {
        let click;
        let label;

        if (isLink) {
          click = () => {
            clipboard.writeText(params.linkURL);
          };
          label = i18n('icu:contextMenuCopyLink');
        } else if (isImage) {
          const urlIsViewOnce =
            params.srcURL?.includes('/temp/') ||
            params.srcURL?.includes('\\temp\\');
          if (urlIsViewOnce) {
            return;
          }

          click = () => {
            const parsedSrcUrl = maybeParseUrl(params.srcURL);
            if (!parsedSrcUrl || parsedSrcUrl.protocol !== 'file:') {
              return;
            }

            const image = nativeImage.createFromPath(
              fileURLToPath(params.srcURL)
            );
            clipboard.writeImage(image);
          };
          label = i18n('icu:contextMenuCopyImage');
        } else {
          label = i18n('icu:editMenuCopy');
          let copyText = params.selectionText.toString()
          click = () => {
            clipboard.writeText(copyText);
          };

        }

        console.log("PARAMS ***********", params.selectionText)
        template.push({
          label,
          role: isLink || isImage ? undefined : undefined,
          click,
        });
      }

      if (editFlags.canPaste && !isImage) {
        template.push({ label: i18n('icu:editMenuPaste'), role: 'paste' });
      }

      if (editFlags.canPaste && !isImage) {
        template.push({
          label: i18n('icu:editMenuPasteAndMatchStyle'),
          role: 'pasteAndMatchStyle',
        });
      }

      // Only enable select all in editors because select all in non-editors
      // results in all the UI being selected
      if (editFlags.canSelectAll && params.isEditable) {
        template.push({
          label: i18n('icu:editMenuSelectAll'),
          role: 'selectAll',
        });
      }

      const menu = Menu.buildFromTemplate(template);
      menu.popup({
        window: browserWindow,
      });
    }
  });
};
