// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import React from 'react';
import { LocalizerType } from '../types/Util';
import { Toast } from './Toast';

type PropsType = {
  i18n: LocalizerType;
  onClose: () => unknown;
};

export const ToastAlreadyGroupMember = ({
  i18n,
  onClose,
}: PropsType): JSX.Element => {
  return (
    <Toast onClose={onClose}>{i18n('GroupV2--join--already-in-group')}</Toast>
  );
};
