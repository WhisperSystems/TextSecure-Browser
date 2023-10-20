import React, { useCallback, useState } from 'react';
import { useDispatch } from 'react-redux';
import { useInterval, useMount } from 'react-use';
import styled from 'styled-components';
import { Data } from '../../../../data/data';
import { useMessageExpirationPropsById } from '../../../../hooks/useParamSelector';
import { MessageModelType } from '../../../../models/messageType';
import { getConversationController } from '../../../../session/conversations';
import { PropsForExpiringMessage, messagesExpired } from '../../../../state/ducks/conversations';
import { getIncrement } from '../../../../util/timer';
import { ExpireTimer } from '../../ExpireTimer';
import { ReadableMessage, ReadableMessageProps } from './ReadableMessage';

const EXPIRATION_CHECK_MINIMUM = 2000;

function useIsExpired(
  props: Omit<PropsForExpiringMessage, 'messageId' | 'direction'> & {
    messageId: string | undefined;
    direction: MessageModelType | undefined;
  }
) {
  const {
    convoId,
    messageId,
    expirationDurationMs,
    expirationTimestamp,
    isExpired: isExpiredProps,
  } = props;

  const dispatch = useDispatch();

  const [isExpired] = useState(isExpiredProps);

  const checkExpired = useCallback(async () => {
    const now = Date.now();

    if (!messageId || !expirationTimestamp || !expirationDurationMs) {
      return;
    }

    if (isExpired || now >= expirationTimestamp) {
      await Data.removeMessage(messageId);
      if (convoId) {
        dispatch(
          messagesExpired([
            {
              conversationKey: convoId,
              messageId,
            },
          ])
        );
        const convo = getConversationController().get(convoId);
        convo?.updateLastMessage();
      }
    }
  }, [messageId, expirationTimestamp, expirationDurationMs, isExpired, convoId, dispatch]);

  let checkFrequency: number | null = null;
  if (expirationDurationMs) {
    const increment = getIncrement(expirationDurationMs || EXPIRATION_CHECK_MINIMUM);
    checkFrequency = Math.max(EXPIRATION_CHECK_MINIMUM, increment);
  }

  useMount(() => {
    void checkExpired();
  }); // check on mount

  useInterval(checkExpired, checkFrequency); // check every 2sec or sooner if needed

  return { isExpired };
}

const StyledReadableMessage = styled(ReadableMessage)<{
  isIncoming: boolean;
}>`
  display: flex;
  justify-content: ${props => (props.isIncoming ? 'flex-start' : 'flex-end')};
  align-items: center;
  width: 100%;
`;

export interface ExpirableReadableMessageProps
  extends Omit<ReadableMessageProps, 'receivedAt' | 'isUnread'> {
  messageId: string;
  isCentered?: boolean;
  isDetailView?: boolean;
}

export const ExpirableReadableMessage = (props: ExpirableReadableMessageProps) => {
  const selected = useMessageExpirationPropsById(props.messageId);

  const { isCentered, onClick, onDoubleClickCapture, role, dataTestId } = props;

  const { isExpired } = useIsExpired({
    convoId: selected?.convoId,
    messageId: selected?.messageId,
    direction: selected?.direction,
    expirationTimestamp: selected?.expirationTimestamp,
    expirationDurationMs: selected?.expirationDurationMs,
    isExpired: selected?.isExpired,
  });

  if (!selected || isExpired) {
    return null;
  }

  const {
    messageId,
    direction: _direction,
    receivedAt,
    isUnread,
    expirationDurationMs,
    expirationTimestamp,
  } = selected;

  // NOTE we want messages on the left in the message detail view regardless of direction
  const direction = props.isDetailView ? 'incoming' : _direction;
  const isIncoming = direction === 'incoming';

  return (
    <StyledReadableMessage
      messageId={messageId}
      receivedAt={receivedAt}
      isUnread={!!isUnread}
      isIncoming={isIncoming}
      onClick={onClick}
      onDoubleClickCapture={onDoubleClickCapture}
      role={role}
      key={`readable-message-${messageId}`}
      dataTestId={dataTestId}
    >
      {expirationDurationMs && expirationTimestamp ? (
        <ExpireTimer
          expirationDurationMs={expirationDurationMs}
          expirationTimestamp={expirationTimestamp}
          style={{
            display: !isCentered && isIncoming ? 'none' : 'block',
            visibility: !isIncoming ? 'visible' : 'hidden',
            flexGrow: !isCentered ? 1 : undefined,
          }}
        />
      ) : null}
      {props.children}
      {expirationDurationMs && expirationTimestamp ? (
        <ExpireTimer
          expirationDurationMs={expirationDurationMs}
          expirationTimestamp={expirationTimestamp}
          style={{
            display: !isCentered && !isIncoming ? 'none' : 'block',
            visibility: isIncoming ? 'visible' : 'hidden',
            flexGrow: !isCentered ? 1 : undefined,
            textAlign: !isCentered ? 'end' : undefined,
          }}
        />
      ) : null}
    </StyledReadableMessage>
  );
};
