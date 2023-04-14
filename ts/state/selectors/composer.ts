// Copyright 2023 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createSelector } from 'reselect';

import type { StateType } from '../reducer';
import type { ComposerStateType, QuotedMessageType } from '../ducks/composer';
import { getComposerStateForConversation } from '../ducks/composer';
import {
  getRemoteConfig,
  getTextFormattingEnabled,
  isRemoteConfigFlagEnabled,
} from './items';

export const getComposerState = (state: StateType): ComposerStateType =>
  state.composer;

export const getComposerStateForConversationIdSelector = createSelector(
  getComposerState,
  composer => (conversationId: string) =>
    getComposerStateForConversation(composer, conversationId)
);

export const getQuotedMessageSelector = createSelector(
  getComposerStateForConversationIdSelector,
  composerStateForConversationIdSelector =>
    (conversationId: string): QuotedMessageType | undefined =>
      composerStateForConversationIdSelector(conversationId).quotedMessage
);

export const getIsFormattingEnabled = createSelector(
  getTextFormattingEnabled,
  getRemoteConfig,
  (isOptionEnabled, remoteConfig) => {
    return (
      isOptionEnabled &&
      isRemoteConfigFlagEnabled(remoteConfig, 'desktop.textFormatting')
    );
  }
);

export const getIsFormattingSpoilersEnabled = createSelector(
  getTextFormattingEnabled,
  getRemoteConfig,
  (isOptionEnabled, remoteConfig) => {
    return (
      isOptionEnabled &&
      isRemoteConfigFlagEnabled(
        remoteConfig,
        'desktop.textFormatting.spoilerSend'
      )
    );
  }
);
