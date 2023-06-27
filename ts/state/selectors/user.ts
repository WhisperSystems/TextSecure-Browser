import { createSelector } from '@reduxjs/toolkit';

import { LocalizerType } from '../../types/Util';

import { StateType } from '../reducer';
import { UserStateType } from '../ducks/user';
import { HTMLDirection, getHTMLDirection } from '../../util/i18n';

export const getUser = (state: StateType): UserStateType => state.user;

export const getOurNumber = createSelector(
  getUser,
  (state: UserStateType): string => state.ourNumber
);

export const getIntl = createSelector(getUser, (): LocalizerType => window.i18n);

export const getWritingDirection = createSelector(getUser, (): HTMLDirection => getHTMLDirection());
