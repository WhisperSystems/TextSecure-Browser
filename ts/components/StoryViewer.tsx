// Copyright 2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import FocusTrap from 'focus-trap-react';
import type { UIEvent } from 'react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import classNames from 'classnames';
import { BlurhashCanvas } from 'react-blurhash';
import type { DraftBodyRanges } from '../types/BodyRange';
import { ThemeType, type LocalizerType } from '../types/Util';
import type { ContextMenuOptionType } from './ContextMenu';
import type {
  ConversationType,
  SaveAttachmentActionCreatorType,
} from '../state/ducks/conversations';
import type { EmojiPickDataType } from './emoji/EmojiPicker';
import type { PreferredBadgeSelectorType } from '../state/selectors/badges';
import type { RenderEmojiPickerProps } from './conversation/ReactionPicker';
import type { ReplyStateType, StoryViewType } from '../types/Stories';
import type { StoryDistributionIdString } from '../types/StoryDistributionId';
import type { ShowToastAction } from '../state/ducks/toast';
import type { ViewStoryActionCreatorType } from '../state/ducks/stories';
import * as log from '../logging/log';
import { AnimatedEmojiGalore } from './AnimatedEmojiGalore';
import { Avatar, AvatarSize } from './Avatar';
import { ConfirmationDialog } from './ConfirmationDialog';
import { ContextMenu } from './ContextMenu';
import { I18n } from './I18n';
import { MessageTimestamp } from './conversation/MessageTimestamp';
import { SendStatus } from '../messages/MessageSendState';
import { Spinner } from './Spinner';
import { StoryDetailsModal } from './StoryDetailsModal';
import { StoryDistributionListName } from './StoryDistributionListName';
import { StoryImage } from './StoryImage';
import {
  ResolvedSendStatus,
  StoryViewDirectionType,
  StoryViewModeType,
  StoryViewTargetType,
} from '../types/Stories';
import { StoryViewsNRepliesModal } from './StoryViewsNRepliesModal';
import { Theme } from '../util/theme';
import { ToastType } from '../types/Toast';
import { getAvatarColor } from '../types/Colors';
import { COLOR_BLACK_ALPHA_90 } from '../util/getStoryBackground';
import { getStoryDuration } from '../util/getStoryDuration';
import { defaultBlurHash, isVideoAttachment } from '../types/Attachment';
import { graphemeAndLinkAwareSlice } from '../util/graphemeAndLinkAwareSlice';
import { useEscapeHandling } from '../hooks/useEscapeHandling';
import { useRetryStorySend } from '../hooks/useRetryStorySend';
import { resolveStorySendStatus } from '../util/resolveStorySendStatus';
import { strictAssert } from '../util/assert';
import { MessageBody } from './conversation/MessageBody';
import { RenderLocation } from './conversation/MessageTextRenderer';
import { arrow } from '../util/keyboard';
import { useElementId } from '../hooks/useUniqueId';
import { StoryProgressSegment } from './StoryProgressSegment';

function renderStrong(parts: Array<JSX.Element | string>) {
  return <strong>{parts}</strong>;
}

export type PropsType = {
  currentIndex: number;
  deleteGroupStoryReply: (id: string) => void;
  deleteGroupStoryReplyForEveryone: (id: string) => void;
  deleteStoryForEveryone: (story: StoryViewType) => unknown;
  distributionList?: { id: StoryDistributionIdString; name: string };
  getPreferredBadge: PreferredBadgeSelectorType;
  group?: Pick<
    ConversationType,
    | 'acceptedMessageRequest'
    | 'avatarUrl'
    | 'color'
    | 'id'
    | 'name'
    | 'profileName'
    | 'sharedGroupNames'
    | 'sortedGroupMembers'
    | 'title'
    | 'left'
  >;
  hasActiveCall?: boolean;
  hasAllStoriesUnmuted: boolean;
  hasViewReceiptSetting: boolean;
  i18n: LocalizerType;
  isFormattingEnabled: boolean;
  isInternalUser?: boolean;
  isSignalConversation?: boolean;
  isWindowActive: boolean;
  loadStoryReplies: (conversationId: string, messageId: string) => unknown;
  markStoryRead: (mId: string) => unknown;
  numStories: number;
  onGoToConversation: (conversationId: string) => unknown;
  onHideStory: (conversationId: string) => unknown;
  onSetSkinTone: (tone: number) => unknown;
  onTextTooLong: () => unknown;
  onReactToStory: (emoji: string, story: StoryViewType) => unknown;
  onReplyToStory: (
    message: string,
    bodyRanges: DraftBodyRanges,
    timestamp: number,
    story: StoryViewType
  ) => unknown;
  onUseEmoji: (_: EmojiPickDataType) => unknown;
  onMediaPlaybackStart: () => void;
  ourConversationId: string | undefined;
  platform: string;
  preferredReactionEmoji: ReadonlyArray<string>;
  queueStoryDownload: (storyId: string) => unknown;
  recentEmojis?: ReadonlyArray<string>;
  renderEmojiPicker: (props: RenderEmojiPickerProps) => JSX.Element;
  replyState?: ReplyStateType;
  retryMessageSend: (messageId: string) => unknown;
  saveAttachment: SaveAttachmentActionCreatorType;
  setHasAllStoriesUnmuted: (isUnmuted: boolean) => unknown;
  showContactModal: (contactId: string, conversationId?: string) => void;
  showToast: ShowToastAction;
  skinTone?: number;
  story: StoryViewType;
  storyViewMode: StoryViewModeType;
  viewStory: ViewStoryActionCreatorType;
  viewTarget?: StoryViewTargetType;
};

const CAPTION_BUFFER = 20;
const CAPTION_INITIAL_LENGTH = 200;
const CAPTION_MAX_LENGTH = 700;
const MOUSE_IDLE_TIME = 3000;

enum Arrow {
  None,
  Left,
  Right,
}

export function StoryViewer({
  currentIndex,
  deleteGroupStoryReply,
  deleteGroupStoryReplyForEveryone,
  deleteStoryForEveryone,
  distributionList,
  getPreferredBadge,
  group,
  hasActiveCall,
  hasAllStoriesUnmuted,
  hasViewReceiptSetting,
  i18n,
  isFormattingEnabled,
  isInternalUser,
  isSignalConversation,
  isWindowActive,
  loadStoryReplies,
  markStoryRead,
  numStories,
  onGoToConversation,
  onHideStory,
  onReactToStory,
  onReplyToStory,
  onSetSkinTone,
  onTextTooLong,
  onUseEmoji,
  onMediaPlaybackStart,
  ourConversationId,
  platform,
  preferredReactionEmoji,
  queueStoryDownload,
  recentEmojis,
  renderEmojiPicker,
  replyState,
  retryMessageSend,
  saveAttachment,
  setHasAllStoriesUnmuted,
  showContactModal,
  showToast,
  skinTone,
  story,
  storyViewMode,
  viewStory,
  viewTarget,
}: PropsType): JSX.Element {
  const [isShowingContextMenu, setIsShowingContextMenu] =
    useState<boolean>(false);
  const [storyDuration, setStoryDuration] = useState<number | undefined>();
  const [hasConfirmHideStory, setHasConfirmHideStory] = useState(false);
  const [reactionEmoji, setReactionEmoji] = useState<string | undefined>();
  const [confirmDeleteStory, setConfirmDeleteStory] = useState<
    StoryViewType | undefined
  >();

  const [viewerId, viewerSelector] = useElementId('StoryViewer');

  const {
    attachment,
    bodyRanges,
    canReply,
    isHidden,
    messageId,
    messageIdForLogging,
    sendState,
    timestamp,
  } = story;
  const {
    acceptedMessageRequest,
    avatarUrl,
    color,
    isMe,
    firstName,
    profileName,
    sharedGroupNames,
    title,
  } = story.sender;

  const conversationId = group?.id || story.sender.id;

  const sendStatus = sendState ? resolveStorySendStatus(sendState) : undefined;
  const { renderAlert, setWasManuallyRetried, wasManuallyRetried } =
    useRetryStorySend(i18n, sendStatus);

  const [currentViewTarget, setCurrentViewTarget] = useState(
    viewTarget ?? null
  );

  useEffect(() => {
    setCurrentViewTarget(viewTarget ?? null);
  }, [viewTarget]);

  const onClose = useCallback(() => {
    viewStory({
      closeViewer: true,
    });
  }, [viewStory]);

  const onEscape = useCallback(() => {
    if (currentViewTarget != null) {
      setCurrentViewTarget(null);
    } else {
      onClose();
    }
  }, [currentViewTarget, onClose]);

  useEscapeHandling(onEscape);

  // Caption related hooks
  const [hasExpandedCaption, setHasExpandedCaption] = useState<boolean>(false);
  const [isSpoilerExpanded, setIsSpoilerExpanded] = useState<
    Record<number, boolean>
  >({});

  const caption = useMemo(() => {
    if (!attachment?.caption) {
      return;
    }

    return graphemeAndLinkAwareSlice(
      attachment.caption,
      hasExpandedCaption ? CAPTION_MAX_LENGTH : CAPTION_INITIAL_LENGTH,
      CAPTION_BUFFER
    );
  }, [attachment?.caption, hasExpandedCaption]);

  // Reset expansion if messageId changes
  useEffect(() => {
    setHasExpandedCaption(false);
    setIsSpoilerExpanded({});
  }, [messageId]);

  // messageId is set as a dependency so that we can reset the story duration
  // when a new story is selected in case the same story (and same attachment)
  // are sequentially posted.
  useEffect(() => {
    let shouldCancel = false;
    void (async function hydrateStoryDuration() {
      if (!attachment) {
        return;
      }
      const duration = await getStoryDuration(attachment);
      if (shouldCancel) {
        return;
      }
      log.info('stories.setStoryDuration', {
        contentType: attachment.textAttachment
          ? 'text'
          : attachment.contentType,
        duration,
      });
      setStoryDuration(duration);
    })();

    return () => {
      shouldCancel = true;
    };
  }, [attachment, messageId]);

  // This guarantees that we'll have a valid ref to the animation when we need it
  strictAssert(currentIndex != null, "StoryViewer: currentIndex can't be null");

  const [pauseStory, setPauseStory] = useState(false);
  const [pressing, setPressing] = useState(false);
  const [longPress, setLongPress] = useState(false);

  useEffect(() => {
    let timer: NodeJS.Timeout | undefined;
    if (pressing) {
      timer = setTimeout(() => {
        setLongPress(true);
      }, 200);
    } else {
      setLongPress(false);
    }
    return () => {
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [pressing]);

  useEffect(() => {
    if (!isWindowActive) {
      setPauseStory(true);
    }
  }, [isWindowActive]);

  // Reset the stuff that pauses a story when you switch story views
  useEffect(() => {
    setConfirmDeleteStory(undefined);
    setHasConfirmHideStory(false);
    setHasExpandedCaption(false);
    setIsSpoilerExpanded({});
    setIsShowingContextMenu(false);
    setPauseStory(false);
    setStoryDuration(undefined);
  }, [story.messageId]);

  const alertElement = renderAlert();

  const shouldPauseViewing =
    storyDuration == null ||
    Boolean(alertElement) ||
    Boolean(confirmDeleteStory) ||
    currentViewTarget != null ||
    hasActiveCall ||
    hasConfirmHideStory ||
    hasExpandedCaption ||
    isShowingContextMenu ||
    pauseStory ||
    Boolean(reactionEmoji) ||
    pressing;

  useEffect(() => {
    markStoryRead(messageId);
    log.info('stories.markStoryRead', { message: messageIdForLogging });
  }, [markStoryRead, messageId, messageIdForLogging]);

  const canFreelyNavigateStories =
    storyViewMode === StoryViewModeType.All ||
    storyViewMode === StoryViewModeType.Hidden ||
    storyViewMode === StoryViewModeType.MyStories ||
    storyViewMode === StoryViewModeType.Unread;

  const canNavigateLeft =
    (storyViewMode === StoryViewModeType.User && currentIndex > 0) ||
    canFreelyNavigateStories;

  const canNavigateRight =
    (storyViewMode === StoryViewModeType.User &&
      currentIndex < numStories - 1) ||
    canFreelyNavigateStories;

  const navigateStories = useCallback(
    (ev: KeyboardEvent) => {
      // the replies modal can consume arrow keys
      // we don't want to navigate while someone is typing a reply
      if (currentViewTarget != null) {
        return;
      }

      if (canNavigateRight && ev.key === arrow('end')) {
        viewStory({
          storyId: story.messageId,
          storyViewMode,
          viewDirection: StoryViewDirectionType.Next,
        });
        ev.preventDefault();
        ev.stopPropagation();
      } else if (canNavigateLeft && ev.key === arrow('start')) {
        viewStory({
          storyId: story.messageId,
          storyViewMode,
          viewDirection: StoryViewDirectionType.Previous,
        });
        ev.preventDefault();
        ev.stopPropagation();
      }
    },
    [
      currentViewTarget,
      canNavigateLeft,
      canNavigateRight,
      story.messageId,
      storyViewMode,
      viewStory,
    ]
  );

  useEffect(() => {
    document.addEventListener('keydown', navigateStories);

    return () => {
      document.removeEventListener('keydown', navigateStories);
    };
  }, [navigateStories]);

  const groupId = group?.id;
  const isGroupStory = Boolean(groupId);
  useEffect(() => {
    if (!groupId) {
      return;
    }
    loadStoryReplies(groupId, messageId);
  }, [groupId, loadStoryReplies, messageId]);

  const [arrowToShow, setArrowToShow] = useState<Arrow>(Arrow.None);

  useEffect(() => {
    if (arrowToShow === Arrow.None) {
      return;
    }

    let mouseMoveExpiration: number | undefined;
    let timer: NodeJS.Timeout | undefined;

    function updateLastMouseMove() {
      mouseMoveExpiration = Date.now() + MOUSE_IDLE_TIME;

      if (timer === undefined) {
        checkMouseIdle();
      }
    }

    function checkMouseIdle() {
      timer = undefined;

      if (mouseMoveExpiration === undefined) {
        return;
      }

      const remaining = mouseMoveExpiration - Date.now();
      if (remaining <= 0) {
        setArrowToShow(Arrow.None);
        return;
      }

      timer = setTimeout(checkMouseIdle, remaining);
    }

    document.addEventListener('mousemove', updateLastMouseMove);

    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      mouseMoveExpiration = undefined;
      timer = undefined;
      document.removeEventListener('mousemove', updateLastMouseMove);
    };
  }, [arrowToShow]);

  const replies =
    replyState && replyState.messageId === messageId ? replyState.replies : [];
  const views = sendState
    ? sendState.filter(({ status }) => status === SendStatus.Viewed)
    : [];
  const replyCount = replies.length;
  const viewCount = views.length;

  const hasAudio = isVideoAttachment(attachment);
  const isStoryMuted = !hasAllStoriesUnmuted || !hasAudio;

  let muteClassName: string;
  let muteAriaLabel: string;
  if (hasAudio) {
    muteAriaLabel = hasAllStoriesUnmuted
      ? i18n('icu:StoryViewer__mute')
      : i18n('icu:StoryViewer__unmute');

    muteClassName = hasAllStoriesUnmuted
      ? 'StoryViewer__mute'
      : 'StoryViewer__unmute';
  } else {
    muteAriaLabel = i18n('icu:Stories__toast--hasNoSound');
    muteClassName = 'StoryViewer__soundless';
  }

  const isSent = Boolean(sendState);

  let contextMenuOptions:
    | ReadonlyArray<ContextMenuOptionType<unknown>>
    | undefined;

  if (isSent) {
    contextMenuOptions = [
      {
        icon: 'StoryListItem__icon--info',
        label: i18n('icu:StoryListItem__info'),
        onClick: () => setCurrentViewTarget(StoryViewTargetType.Details),
      },
      {
        icon: 'StoryListItem__icon--delete',
        label: i18n('icu:StoryListItem__delete'),
        onClick: () => setConfirmDeleteStory(story),
      },
    ];
  } else if (!isSignalConversation) {
    contextMenuOptions = [
      {
        icon: 'StoryListItem__icon--info',
        label: i18n('icu:StoryListItem__info'),
        onClick: () => setCurrentViewTarget(StoryViewTargetType.Details),
      },
      {
        icon: isHidden
          ? 'StoryListItem__icon--unhide'
          : 'StoryListItem__icon--hide',
        label: isHidden
          ? i18n('icu:StoryListItem__unhide')
          : i18n('icu:StoryListItem__hide'),
        onClick: () => {
          if (isHidden) {
            onHideStory(conversationId);
          } else {
            setHasConfirmHideStory(true);
          }
        },
      },
      {
        icon: 'StoryListItem__icon--chat',
        label: i18n('icu:StoryListItem__go-to-chat'),
        onClick: () => {
          onGoToConversation(conversationId);
        },
      },
    ];
  }

  function doRetryMessageSend() {
    if (wasManuallyRetried) {
      return;
    }

    if (
      sendStatus !== ResolvedSendStatus.Failed &&
      sendStatus !== ResolvedSendStatus.PartiallySent
    ) {
      return;
    }

    setWasManuallyRetried(true);
    retryMessageSend(messageId);
  }

  function isDescendentEvent(event: UIEvent) {
    // Can occur when the user clicks on the overlay of an open modal
    return event.currentTarget.contains(event.target as Node);
  }

  // .StoryViewer has events to pause the story, but certain elements it
  // contains should not trigger that behavior.
  const stopPauseBubblingProps = {
    onMouseDown: (event: UIEvent) => event.stopPropagation(),
    onKeyDown: (event: UIEvent) => event.stopPropagation(),
  };

  return (
    <FocusTrap
      focusTrapOptions={{
        clickOutsideDeactivates: true,
        initialFocus: viewerSelector,
      }}
    >
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        className="StoryViewer"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        id={viewerId}
        onMouseDown={event => {
          if (isDescendentEvent(event)) {
            setPressing(true);
          }
        }}
        onDragStart={() => setPressing(false)}
        onMouseUp={() => setPressing(false)}
        onKeyDown={event => {
          if (isDescendentEvent(event) && event.code === 'Space') {
            setPressing(true);
          }
        }}
        onKeyUp={event => {
          if (event.code === 'Space') {
            setPressing(false);
          }
        }}
      >
        {alertElement}

        {attachment ? (
          <BlurhashCanvas
            className="StoryViewer__overlay"
            hash={attachment.blurHash || defaultBlurHash(ThemeType.dark)}
            width={attachment.width}
            height={attachment.height}
          />
        ) : (
          <div
            className="StoryViewer__overlay"
            style={{ background: COLOR_BLACK_ALPHA_90 }}
          />
        )}

        <div className="StoryViewer__content">
          {canNavigateLeft && (
            <button
              aria-label={i18n('icu:back')}
              className={classNames(
                'StoryViewer__arrow StoryViewer__arrow--left',
                {
                  'StoryViewer__arrow--visible': arrowToShow === Arrow.Left,
                }
              )}
              onClick={() =>
                viewStory({
                  storyId: story.messageId,
                  storyViewMode,
                  viewDirection: StoryViewDirectionType.Previous,
                })
              }
              onMouseMove={() => setArrowToShow(Arrow.Left)}
              type="button"
            />
          )}
          <div className="StoryViewer__protection StoryViewer__protection--top" />
          <div
            className="StoryViewer__container"
            onDoubleClick={() =>
              setCurrentViewTarget(StoryViewTargetType.Replies)
            }
          >
            <StoryImage
              attachment={attachment}
              firstName={firstName || title}
              isMe={isMe}
              i18n={i18n}
              isPaused={shouldPauseViewing}
              isMuted={isStoryMuted}
              label={i18n('icu:lightboxImageAlt')}
              moduleClassName="StoryViewer__story"
              queueStoryDownload={queueStoryDownload}
              storyId={messageId}
              onMediaPlaybackStart={onMediaPlaybackStart}
            >
              {reactionEmoji && (
                <div className="StoryViewer__animated-emojis">
                  <AnimatedEmojiGalore
                    emoji={reactionEmoji}
                    onAnimationEnd={() => {
                      setReactionEmoji(undefined);
                    }}
                  />
                </div>
              )}
            </StoryImage>
            {hasExpandedCaption && (
              <button
                aria-label={i18n('icu:close-popup')}
                className="StoryViewer__CAPTION__overlay"
                onClick={() => setHasExpandedCaption(false)}
                type="button"
              />
            )}
          </div>

          <div
            className={classNames(
              'StoryViewer__protection',
              'StoryViewer__protection--bottom',
              {
                'StoryViewer__protection--has-caption': caption != null,
              }
            )}
          />

          {hasExpandedCaption && (
            <div className="StoryViewer__protection StoryViewer__protection--whole" />
          )}

          {canNavigateRight && (
            <button
              aria-label={i18n('icu:forward')}
              className={classNames(
                'StoryViewer__arrow StoryViewer__arrow--right',
                {
                  'StoryViewer__arrow--visible': arrowToShow === Arrow.Right,
                }
              )}
              onClick={() =>
                viewStory({
                  storyId: story.messageId,
                  storyViewMode,
                  viewDirection: StoryViewDirectionType.Next,
                })
              }
              onMouseMove={() => setArrowToShow(Arrow.Right)}
              type="button"
            />
          )}

          <div className="StoryViewer__meta">
            {caption && (
              <div className="StoryViewer__caption">
                <MessageBody
                  bodyRanges={bodyRanges}
                  i18n={i18n}
                  isSpoilerExpanded={isSpoilerExpanded}
                  onExpandSpoiler={data => setIsSpoilerExpanded(data)}
                  renderLocation={RenderLocation.StoryViewer}
                  text={caption.text}
                />
                {caption.hasReadMore && !hasExpandedCaption && (
                  <button
                    className="MessageBody__read-more"
                    onClick={() => {
                      setHasExpandedCaption(true);
                    }}
                    onKeyDown={(ev: React.KeyboardEvent) => {
                      if (ev.key === 'Space' || ev.key === 'Enter') {
                        setHasExpandedCaption(true);
                      }
                    }}
                    type="button"
                  >
                    ...
                    {i18n('icu:MessageBody--read-more')}
                  </button>
                )}
              </div>
            )}
            <div className="StoryViewer__meta__playback-bar">
              <div className="StoryViewer__meta__playback-bar__container">
                <Avatar
                  acceptedMessageRequest={acceptedMessageRequest}
                  avatarUrl={avatarUrl}
                  badge={undefined}
                  color={getAvatarColor(color)}
                  conversationType="direct"
                  i18n={i18n}
                  isMe={Boolean(isMe)}
                  profileName={profileName}
                  sharedGroupNames={sharedGroupNames}
                  size={AvatarSize.TWENTY_EIGHT}
                  title={title}
                />
                {group && (
                  <Avatar
                    acceptedMessageRequest={group.acceptedMessageRequest}
                    avatarUrl={group.avatarUrl}
                    badge={undefined}
                    className="StoryViewer__meta--group-avatar"
                    color={getAvatarColor(group.color)}
                    conversationType="group"
                    i18n={i18n}
                    isMe={false}
                    profileName={group.profileName}
                    sharedGroupNames={group.sharedGroupNames}
                    size={AvatarSize.TWENTY_EIGHT}
                    title={group.title}
                  />
                )}
                <div className="StoryViewer__meta--title-container">
                  <div className="StoryViewer__meta--title">
                    {(group &&
                      i18n('icu:Stories__from-to-group', {
                        name: isMe ? i18n('icu:you') : title,
                        group: group.title,
                      })) ||
                      (isMe ? i18n('icu:you') : title)}
                  </div>
                  <MessageTimestamp
                    i18n={i18n}
                    isRelativeTime
                    module="StoryViewer__meta--timestamp"
                    timestamp={timestamp}
                  />
                  {distributionList && (
                    <div className="StoryViewer__meta__list">
                      <StoryDistributionListName
                        id={distributionList.id}
                        name={distributionList.name}
                        i18n={i18n}
                      />
                    </div>
                  )}
                </div>
              </div>
              <div
                className="StoryViewer__meta__playback-controls"
                {...stopPauseBubblingProps}
              >
                <button
                  aria-label={
                    pauseStory || longPress
                      ? i18n('icu:StoryViewer__play')
                      : i18n('icu:StoryViewer__pause')
                  }
                  className={
                    pauseStory || longPress
                      ? 'StoryViewer__play'
                      : 'StoryViewer__pause'
                  }
                  onClick={() => setPauseStory(!pauseStory)}
                  type="button"
                />
                <button
                  aria-label={muteAriaLabel}
                  className={muteClassName}
                  onClick={
                    hasAudio
                      ? () => setHasAllStoriesUnmuted(!hasAllStoriesUnmuted)
                      : () => showToast({ toastType: ToastType.StoryMuted })
                  }
                  type="button"
                />
                {contextMenuOptions && (
                  <ContextMenu
                    aria-label={i18n('icu:MyStories__more')}
                    i18n={i18n}
                    menuOptions={contextMenuOptions}
                    moduleClassName="StoryViewer__more"
                    onMenuShowingChanged={setIsShowingContextMenu}
                    theme={Theme.Dark}
                  />
                )}
              </div>
            </div>
            <div className="StoryViewer__progress" {...stopPauseBubblingProps}>
              {Array.from(Array(numStories), (_, index) => (
                <StoryProgressSegment
                  key={`${story.messageId}-${index}-${currentIndex}`}
                  index={index}
                  currentIndex={currentIndex}
                  duration={storyDuration ?? null}
                  playing={!shouldPauseViewing}
                  onFinish={() => {
                    viewStory({
                      storyId: story.messageId,
                      storyViewMode,
                      viewDirection: StoryViewDirectionType.Next,
                    });
                  }}
                />
              ))}
            </div>
            <div className="StoryViewer__actions" {...stopPauseBubblingProps}>
              {sendStatus === ResolvedSendStatus.Failed &&
                !wasManuallyRetried && (
                  <button
                    className="StoryViewer__actions__failed"
                    onClick={doRetryMessageSend}
                    type="button"
                  >
                    {i18n('icu:StoryViewer__failed')}
                  </button>
                )}
              {sendStatus === ResolvedSendStatus.PartiallySent &&
                !wasManuallyRetried && (
                  <button
                    className="StoryViewer__actions__failed"
                    onClick={doRetryMessageSend}
                    type="button"
                  >
                    {i18n('icu:StoryViewer__partial-fail')}
                  </button>
                )}
              {sendStatus === ResolvedSendStatus.Sending && (
                <div className="StoryViewer__sending">
                  <Spinner
                    moduleClassName="StoryViewer__sending__spinner"
                    svgSize="small"
                  />
                  {i18n('icu:StoryViewer__sending')}
                </div>
              )}
              {(canReply ||
                (isSent && sendStatus === ResolvedSendStatus.Sent)) && (
                <button
                  className="StoryViewer__reply"
                  onClick={() =>
                    setCurrentViewTarget(StoryViewTargetType.Replies)
                  }
                  tabIndex={0}
                  type="button"
                >
                  {isSent || replyCount > 0 ? (
                    <span className="StoryViewer__reply__chevron">
                      <span>
                        {isSent && !hasViewReceiptSetting && !replyCount && (
                          <>{i18n('icu:StoryViewer__views-off')}</>
                        )}
                        {isSent && hasViewReceiptSetting && (
                          <I18n
                            i18n={i18n}
                            id="icu:MyStories__views--strong"
                            components={{
                              views: viewCount,
                              strong: renderStrong,
                            }}
                          />
                        )}
                        {(isSent || viewCount > 0) && replyCount > 0 && ' '}
                        {replyCount > 0 && (
                          <I18n
                            i18n={i18n}
                            id="icu:MyStories__replies"
                            components={{ replyCount, strong: renderStrong }}
                          />
                        )}
                      </span>
                    </span>
                  ) : null}
                  {!isSent && !replyCount && (
                    <span className="StoryViewer__reply__arrow">
                      {isGroupStory
                        ? i18n('icu:StoryViewer__reply-group')
                        : i18n('icu:StoryViewer__reply')}
                    </span>
                  )}
                </button>
              )}
            </div>
          </div>
          <button
            aria-label={i18n('icu:close')}
            className="StoryViewer__close-button"
            onClick={onClose}
            tabIndex={0}
            type="button"
          />
        </div>
        {currentViewTarget === StoryViewTargetType.Details && (
          <StoryDetailsModal
            attachment={attachment}
            getPreferredBadge={getPreferredBadge}
            i18n={i18n}
            isInternalUser={isInternalUser}
            onClose={() => setCurrentViewTarget(null)}
            saveAttachment={saveAttachment}
            sender={story.sender}
            sendState={sendState}
            timestamp={timestamp}
            expirationTimestamp={story.expirationTimestamp}
          />
        )}
        {(currentViewTarget === StoryViewTargetType.Replies ||
          currentViewTarget === StoryViewTargetType.Views) && (
          <StoryViewsNRepliesModal
            authorTitle={firstName || title}
            canReply={Boolean(canReply)}
            getPreferredBadge={getPreferredBadge}
            hasViewReceiptSetting={hasViewReceiptSetting}
            hasViewsCapability={isSent}
            i18n={i18n}
            platform={platform}
            isFormattingEnabled={isFormattingEnabled}
            isInternalUser={isInternalUser}
            group={group}
            onClose={() => setCurrentViewTarget(null)}
            onReact={emoji => {
              onReactToStory(emoji, story);
              if (!isGroupStory) {
                setCurrentViewTarget(null);
                showToast({ toastType: ToastType.StoryReact });
              }
              setReactionEmoji(emoji);
            }}
            onReply={(message, replyBodyRanges, replyTimestamp) => {
              if (!isGroupStory) {
                setCurrentViewTarget(null);
                showToast({ toastType: ToastType.StoryReply });
              }
              onReplyToStory(message, replyBodyRanges, replyTimestamp, story);
            }}
            onSetSkinTone={onSetSkinTone}
            onTextTooLong={onTextTooLong}
            onUseEmoji={onUseEmoji}
            ourConversationId={ourConversationId}
            preferredReactionEmoji={preferredReactionEmoji}
            recentEmojis={recentEmojis}
            renderEmojiPicker={renderEmojiPicker}
            replies={replies}
            showContactModal={showContactModal}
            skinTone={skinTone}
            sortedGroupMembers={group?.sortedGroupMembers}
            views={views}
            viewTarget={currentViewTarget}
            onChangeViewTarget={setCurrentViewTarget}
            deleteGroupStoryReply={deleteGroupStoryReply}
            deleteGroupStoryReplyForEveryone={deleteGroupStoryReplyForEveryone}
          />
        )}
        {hasConfirmHideStory && (
          <ConfirmationDialog
            dialogName="StoryViewer.confirmHideStory"
            actions={[
              {
                action: () => {
                  onHideStory(conversationId);
                  onClose();
                },
                style: 'affirmative',
                text: i18n('icu:StoryListItem__hide-modal--confirm'),
              },
            ]}
            i18n={i18n}
            onClose={() => {
              setHasConfirmHideStory(false);
            }}
          >
            {i18n('icu:StoryListItem__hide-modal--body', {
              name: String(firstName),
            })}
          </ConfirmationDialog>
        )}
        {confirmDeleteStory && (
          <ConfirmationDialog
            dialogName="StoryViewer.deleteStory"
            actions={[
              {
                text: i18n('icu:delete'),
                action: () => deleteStoryForEveryone(confirmDeleteStory),
                style: 'negative',
              },
            ]}
            i18n={i18n}
            onClose={() => setConfirmDeleteStory(undefined)}
          >
            {i18n('icu:MyStories__delete')}
          </ConfirmationDialog>
        )}
      </div>
    </FocusTrap>
  );
}
