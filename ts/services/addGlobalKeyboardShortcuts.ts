// Copyright 2023 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import * as KeyboardLayout from './keyboardLayout';
import * as log from '../logging/log';
import { PanelType } from '../types/Panels';
import { clearConversationDraftAttachments } from '../util/clearConversationDraftAttachments';
import { drop } from '../util/drop';
import { matchOrQueryFocusable } from '../util/focusableSelectors';
import { getQuotedMessageSelector } from '../state/selectors/composer';
import { removeLinkPreview } from './LinkPreview';
import { ForwardMessagesModalType } from '../components/ForwardMessagesModal';

export function addGlobalKeyboardShortcuts(): void {
  const isMacOS = window.platform === 'darwin';

  document.addEventListener('keydown', event => {
    const { ctrlKey, metaKey, shiftKey, altKey } = event;

    const commandKey = isMacOS && metaKey;
    const controlKey = !isMacOS && ctrlKey;
    const commandOrCtrl = commandKey || controlKey;

    const state = window.reduxStore.getState();
    const { selectedConversationId } = state.conversations;
    const conversation = window.ConversationController.get(
      selectedConversationId
    );

    const key = KeyboardLayout.lookup(event);

    // NAVIGATION

    // Show keyboard shortcuts - handled by Electron-managed keyboard shortcuts
    // However, on linux Ctrl+/ selects all text, so we prevent that
    if (commandOrCtrl && !altKey && key === '/') {
      window.Events.showKeyboardShortcuts();

      event.stopPropagation();
      event.preventDefault();

      return;
    }

    // Super tab :(
    if (
      (commandOrCtrl && key === 'F6') ||
      (commandOrCtrl && !shiftKey && (key === 't' || key === 'T'))
    ) {
      window.enterKeyboardMode();
      const focusedElement = document.activeElement;
      const targets = Array.from(
        document.querySelectorAll<HTMLElement>('[data-supertab="true"]')
      );
      const focusedIndexes: Array<number> = [];

      targets.forEach((target, index) => {
        if (target.contains(focusedElement)) {
          focusedIndexes.push(index);
        }
      });

      if (focusedIndexes.length > 1) {
        log.error(
          `supertab: found multiple supertab elements containing the current active element: ${focusedIndexes.join(
            ', '
          )}`
        );
      }

      // Default to the last focusable element to avoid cycles when multiple
      // elements match (generally going to be a parent element)
      const focusedIndex = focusedIndexes.at(-1) ?? -1;

      const lastIndex = targets.length - 1;

      let index: number | undefined;
      if (focusedIndex < 0) {
        index = shiftKey ? lastIndex : 0;
      } else {
        const increment = shiftKey ? lastIndex : 1;
        index = (focusedIndex + increment) % targets.length;
      }

      const node = targets[index];
      const firstFocusableElement = matchOrQueryFocusable(node);

      if (firstFocusableElement) {
        firstFocusableElement.focus();
      } else {
        if (node) {
          const nodeInfo = Array.from(node.attributes)
            .map(attr => `${attr.name}=${attr.value}`)
            .join(',');
          log.warn(
            `supertab: could not find focus for DOM node ${node.nodeName}<${nodeInfo}>`
          );
        }

        window.enterMouseMode();
        const { activeElement } = document;
        if (
          activeElement &&
          'blur' in activeElement &&
          typeof activeElement.blur === 'function'
        ) {
          activeElement.blur();
        }
      }
    }

    // Cancel out of keyboard shortcut screen - has first precedence
    const isShortcutGuideModalVisible = window.reduxStore
      ? window.reduxStore.getState().globalModals.isShortcutGuideModalVisible
      : false;
    if (isShortcutGuideModalVisible && key === 'Escape') {
      window.reduxActions.globalModals.closeShortcutGuideModal();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Escape is heavily overloaded - here we avoid clashes with other Escape handlers
    if (key === 'Escape') {
      // Check origin - if within a react component which handles escape, don't handle.
      //   Why? Because React's synthetic events can cause events to be handled twice.
      const target = document.activeElement;

      // We might want to use NamedNodeMap.getNamedItem('class')
      /* eslint-disable @typescript-eslint/no-explicit-any */
      if (
        target &&
        target.attributes &&
        (target.attributes as any).class &&
        (target.attributes as any).class.value
      ) {
        const className = (target.attributes as any).class.value;
        /* eslint-enable @typescript-eslint/no-explicit-any */

        // Search box wants to handle events internally
        if (className.includes('LeftPaneSearchInput__input')) {
          return;
        }
      }

      // These add listeners to document, but we'll run first
      const confirmationModal = document.querySelector(
        '.module-confirmation-dialog__overlay'
      );
      if (confirmationModal) {
        return;
      }

      const emojiPicker = document.querySelector('.module-emoji-picker');
      if (emojiPicker) {
        return;
      }

      const lightBox = document.querySelector('.Lightbox');
      if (lightBox) {
        return;
      }

      const stickerPicker = document.querySelector('.module-sticker-picker');
      if (stickerPicker) {
        return;
      }

      const stickerPreview = document.querySelector(
        '.module-sticker-manager__preview-modal__overlay'
      );
      if (stickerPreview) {
        return;
      }

      const reactionViewer = document.querySelector('.module-reaction-viewer');
      if (reactionViewer) {
        return;
      }

      const reactionPicker = document.querySelector('.module-ReactionPicker');
      if (reactionPicker) {
        return;
      }

      const contactModal = document.querySelector('.module-contact-modal');
      if (contactModal) {
        return;
      }

      const modalHost = document.querySelector('.module-modal-host__overlay');
      if (modalHost) {
        return;
      }
    }

    // Send Escape to active conversation so it can close panels
    if (conversation && key === 'Escape') {
      window.reduxActions.conversations.popPanelForConversation();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Preferences - handled by Electron-managed keyboard shortcuts

    // Open the top-right menu for current conversation
    if (
      conversation &&
      commandOrCtrl &&
      shiftKey &&
      (key === 'l' || key === 'L')
    ) {
      const button = document.querySelector(
        '.module-ConversationHeader__button--more'
      );
      if (!button) {
        return;
      }

      // Because the menu is shown at a location based on the initiating click, we need
      //   to fake up a mouse event to get the menu to show somewhere other than (0,0).
      const { x, y, width, height } = button.getBoundingClientRect();
      const mouseEvent = document.createEvent('MouseEvents');
      // Types do not match signature
      /* eslint-disable @typescript-eslint/no-explicit-any */
      mouseEvent.initMouseEvent(
        'click',
        true, // bubbles
        false, // cancelable
        null as any, // view
        null as any, // detail
        0, // screenX,
        0, // screenY,
        x + width / 2,
        y + height / 2,
        false, // ctrlKey,
        false, // altKey,
        false, // shiftKey,
        false, // metaKey,
        false as any, // button,
        document.body
      );
      /* eslint-enable @typescript-eslint/no-explicit-any */

      button.dispatchEvent(mouseEvent);

      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Focus composer field
    if (
      conversation &&
      commandOrCtrl &&
      shiftKey &&
      (key === 't' || key === 'T')
    ) {
      window.reduxActions.composer.setComposerFocus(conversation.id);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (
      conversation &&
      commandOrCtrl &&
      !shiftKey &&
      (key === 'j' || key === 'J')
    ) {
      window.enterKeyboardMode();
      const item: HTMLElement | null =
        document.querySelector(
          '.module-last-seen-indicator ~ div .module-message'
        ) ||
        document.querySelector(
          '.module-timeline__last-message .module-message'
        );
      item?.focus();
    }

    // Open all media
    if (
      conversation &&
      commandOrCtrl &&
      shiftKey &&
      (key === 'm' || key === 'M')
    ) {
      window.reduxActions.conversations.pushPanelForConversation({
        type: PanelType.AllMedia,
      });
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Open emoji picker - handled by component

    // Open sticker picker - handled by component

    // Begin recording voice note - handled by component

    // Archive or unarchive conversation
    if (
      conversation &&
      !conversation.get('isArchived') &&
      commandOrCtrl &&
      shiftKey &&
      (key === 'a' || key === 'A')
    ) {
      event.preventDefault();
      event.stopPropagation();

      window.reduxActions.conversations.onArchive(conversation.id);

      // It's very likely that the act of archiving a conversation will set focus to
      //   'none,' or the top-level body element. This resets it to the left pane.
      if (document.activeElement === document.body) {
        const leftPaneEl: HTMLElement | null = document.querySelector(
          '.module-left-pane__list'
        );
        if (leftPaneEl) {
          leftPaneEl.focus();
        }
      }

      return;
    }
    if (
      conversation &&
      conversation.get('isArchived') &&
      commandOrCtrl &&
      shiftKey &&
      (key === 'u' || key === 'U')
    ) {
      event.preventDefault();
      event.stopPropagation();

      window.reduxActions.conversations.onMoveToInbox(conversation.id);

      return;
    }

    // Scroll to bottom of list - handled by component

    // Scroll to top of list - handled by component

    // Close conversation
    if (
      conversation &&
      commandOrCtrl &&
      shiftKey &&
      (key === 'c' || key === 'C')
    ) {
      event.preventDefault();
      event.stopPropagation();

      window.reduxActions.conversations.onConversationClosed(
        conversation.id,
        'keyboard shortcut close'
      );
      window.reduxActions.conversations.showConversation({
        conversationId: undefined,
        messageId: undefined,
      });

      return;
    }

    // MESSAGES

    // Show message details
    if (
      conversation &&
      commandOrCtrl &&
      !shiftKey &&
      (key === 'd' || key === 'D')
    ) {
      event.preventDefault();
      event.stopPropagation();

      const { targetedMessage } = state.conversations;
      if (!targetedMessage) {
        return;
      }

      window.reduxActions.conversations.pushPanelForConversation({
        type: PanelType.MessageDetails,
        args: {
          messageId: targetedMessage,
        },
      });
      return;
    }

    // Toggle reply to message
    if (
      conversation &&
      commandOrCtrl &&
      shiftKey &&
      (key === 'r' || key === 'R')
    ) {
      event.preventDefault();
      event.stopPropagation();

      const { targetedMessage } = state.conversations;

      const quotedMessageSelector = getQuotedMessageSelector(state);
      const quote = quotedMessageSelector(conversation.id);

      window.reduxActions.composer.setQuoteByMessageId(
        conversation.id,
        quote ? undefined : targetedMessage
      );

      return;
    }

    // Save attachment
    if (
      conversation &&
      commandOrCtrl &&
      !shiftKey &&
      (key === 's' || key === 'S')
    ) {
      event.preventDefault();
      event.stopPropagation();

      const { targetedMessage } = state.conversations;

      if (targetedMessage) {
        window.reduxActions.conversations.saveAttachmentFromMessage(
          targetedMessage
        );
        return;
      }
    }

    if (
      conversation &&
      commandOrCtrl &&
      shiftKey &&
      (key === 'd' || key === 'D')
    ) {
      const { forwardMessagesProps } = state.globalModals;
      const { targetedMessage, selectedMessageIds } = state.conversations;

      const messageIds =
        selectedMessageIds ??
        (targetedMessage != null ? [targetedMessage] : null);

      if (forwardMessagesProps == null && messageIds != null) {
        event.preventDefault();
        event.stopPropagation();

        window.reduxActions.globalModals.toggleDeleteMessagesModal({
          conversationId: conversation.id,
          messageIds,
          onDelete() {
            if (selectedMessageIds != null) {
              window.reduxActions.conversations.toggleSelectMode(false);
            }
          },
        });

        return;
      }
    }

    if (
      conversation &&
      commandOrCtrl &&
      shiftKey &&
      (key === 's' || key === 'S')
    ) {
      const { hasConfirmationModal } = state.globalModals;
      const { targetedMessage, selectedMessageIds } = state.conversations;

      const messageIds =
        selectedMessageIds ??
        (targetedMessage != null ? [targetedMessage] : null);

      if (!hasConfirmationModal && messageIds != null) {
        event.preventDefault();
        event.stopPropagation();

        window.reduxActions.globalModals.toggleForwardMessagesModal(
          { type: ForwardMessagesModalType.Forward, messageIds },
          () => {
            if (selectedMessageIds != null) {
              window.reduxActions.conversations.toggleSelectMode(false);
            }
          }
        );

        return;
      }
    }

    // COMPOSER

    // Create a newline in your message - handled by component

    // Expand composer - handled by component

    // Send in expanded composer - handled by component

    // Attach file
    // hooks/useKeyboardShorcuts useAttachFileShortcut

    // Remove draft link preview
    if (
      conversation &&
      commandOrCtrl &&
      !shiftKey &&
      (key === 'p' || key === 'P')
    ) {
      removeLinkPreview(conversation.id);

      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Attach file
    if (
      conversation &&
      commandOrCtrl &&
      shiftKey &&
      (key === 'p' || key === 'P')
    ) {
      drop(
        clearConversationDraftAttachments(
          conversation.id,
          conversation.get('draftAttachments')
        )
      );

      event.preventDefault();
      event.stopPropagation();
      // Commented out because this is the last item
      // return;
    }
  });
}
