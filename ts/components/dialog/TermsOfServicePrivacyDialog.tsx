import { noop } from 'lodash';
import { useDispatch } from 'react-redux';
import styled from 'styled-components';
import { updateTermsOfServicePrivacyModal } from '../../state/onboarding/ducks/modals';
import { SessionWrapperModal } from '../SessionWrapperModal';
import { Flex } from '../basic/Flex';
import { SessionButton, SessionButtonShape, SessionButtonType } from '../basic/SessionButton';
import { SpacerSM } from '../basic/Text';

// NOTE we want to bypass the padding on the modal body so the buttons take up the full space
const ConfirmButtonContainer = styled(Flex)`
  margin: 0px calc(var(--margins-lg) * -1) calc(var(--margins-lg) * -1) calc(var(--margins-lg) * -1);
`;

export type TermsOfServicePrivacyDialogProps = {
  show: boolean;
};

export function TermsOfServicePrivacyDialog(props: TermsOfServicePrivacyDialogProps) {
  const { show } = props;

  const dispatch = useDispatch();

  const onClose = () => {
    dispatch(updateTermsOfServicePrivacyModal(null));
  };

  if (!show) {
    return null;
  }

  return (
    <SessionWrapperModal
      title={window.i18n('urlOpen')}
      onClose={onClose}
      showExitIcon={true}
      showHeader={true}
      headerReverse={true}
    >
      <div className="session-modal__centered">
        <span>{window.i18n('urlOpenBrowser')}</span>
        <SpacerSM />
        <ConfirmButtonContainer container={true} justifyContent="center" alignItems="center">
          <SessionButton
            text={window.i18n('termsOfService')}
            buttonType={SessionButtonType.ModalConfirm}
            buttonShape={SessionButtonShape.None}
            onClick={noop}
            dataTestId="session-tos-button"
          />
          <SessionButton
            text={window.i18n('privacyPolicy')}
            buttonType={SessionButtonType.ModalConfirm}
            buttonShape={SessionButtonShape.None}
            onClick={noop}
            dataTestId="session-privacy-policy-button"
          />
        </ConfirmButtonContainer>
      </div>
    </SessionWrapperModal>
  );
}
