// Copyright 2017 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { installCallback, installSetting } from '../util/preload';

// ChatColorPicker redux hookups
installCallback('getCustomColors');
installCallback('getConversationsWithCustomColor');
installCallback('addCustomColor');
installCallback('editCustomColor');
installCallback('removeCustomColor');
installCallback('removeCustomColorOnConversations');
installCallback('resetAllChatColors');
installCallback('resetDefaultChatColor');
installCallback('setGlobalDefaultConversationColor');
installCallback('getDefaultConversationColor');
installCallback('persistZoomFactor');
installCallback('closeDB');

// Getters only. These are set by the primary device
installSetting('blockedCount', {
  setter: false,
});
installSetting('linkPreviewSetting', {
  setter: false,
});
installSetting('phoneNumberDiscoverabilitySetting', {
  setter: false,
});
installSetting('phoneNumberSharingSetting', {
  setter: false,
});
installSetting('readReceiptSetting', {
  setter: false,
});
installSetting('typingIndicatorSetting', {
  setter: false,
});

installCallback('deleteAllMyStories');
installCallback('isPhoneNumberSharingEnabled');
installCallback('isPrimary');
installCallback('shouldShowStoriesSettings');
installCallback('syncRequest');

installSetting('alwaysRelayCalls');
installSetting('audioNotification');
installSetting('autoDownloadUpdate');
installSetting('autoLaunch');
installSetting('callRingtoneNotification');
installSetting('callSystemNotification');
installSetting('countMutedConversations');
installSetting('deviceName');
installSetting('enterKeySends');
installSetting('hasStoriesDisabled');
installSetting('hideMenuBar');
installSetting('incomingCallNotification');
installSetting('lastSyncTime');
installSetting('notificationDrawAttention');
installSetting('notificationSetting');
installSetting('spellCheck');
installSetting('systemTraySetting');
installSetting('sentMediaQualitySetting');
installSetting('themeSetting');
installSetting('universalExpireTimer');
installSetting('zoomFactor');

// Media Settings
installCallback('getAvailableIODevices');
installSetting('preferredAudioInputDevice');
installSetting('preferredAudioOutputDevice');
installSetting('preferredVideoInputDevice');
