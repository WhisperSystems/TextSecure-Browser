// Copyright 2019 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
import * as log from '../logging/log';
import * as Bytes from '../Bytes';
import type { AttachmentDownloadJobTypeType } from '../types/AttachmentDownload';

import type { MessageModel } from '../models/messages';
import type { AttachmentType } from '../types/Attachment';
import { getAttachmentSignature, isDownloaded } from '../types/Attachment';

export async function addAttachmentToMessage(
  message: MessageModel | null | undefined,
  attachment: AttachmentType,
  { type }: { type: AttachmentDownloadJobTypeType }
): Promise<void> {
  if (!message) {
    return;
  }

  const logPrefix = `${message.idForLogging()} (type: ${type})`;
  const attachmentSignature = getAttachmentSignature(attachment);

  if (type === 'long-message') {
    let handledAnywhere = false;
    let attachmentData: Uint8Array | undefined;

    try {
      if (attachment.path) {
        const loaded = await window.Signal.Migrations.loadAttachmentData(
          attachment
        );
        attachmentData = loaded.data;
      }

      const editHistory = message.get('editHistory');
      if (editHistory) {
        let handledInEditHistory = false;

        const newEditHistory = editHistory.map(edit => {
          // We've already downloaded a bodyAttachment for this edit
          if (!edit.bodyAttachment) {
            return edit;
          }
          // This attachment isn't destined for this edit
          if (
            getAttachmentSignature(edit.bodyAttachment) !== attachmentSignature
          ) {
            return edit;
          }

          handledInEditHistory = true;
          handledAnywhere = true;

          // Attachment wasn't downloaded yet.
          if (!attachmentData) {
            return {
              ...edit,
              bodyAttachment: attachment,
            };
          }

          return {
            ...edit,
            body: Bytes.toString(attachmentData),
            bodyAttachment: undefined,
          };
        });

        if (handledInEditHistory) {
          message.set({ editHistory: newEditHistory });
        }
      }

      const existingBodyAttachment = message.get('bodyAttachment');
      // A bodyAttachment download might apply only to an edit, and not the top-level
      if (!existingBodyAttachment) {
        return;
      }
      if (
        getAttachmentSignature(existingBodyAttachment) !== attachmentSignature
      ) {
        return;
      }

      handledAnywhere = true;

      // Attachment wasn't downloaded yet.
      if (!attachmentData) {
        message.set({
          bodyAttachment: attachment,
        });
        return;
      }

      message.set({
        body: Bytes.toString(attachmentData),
        bodyAttachment: undefined,
      });
    } finally {
      if (attachment.path) {
        await window.Signal.Migrations.deleteAttachmentData(attachment.path);
      }
      if (!handledAnywhere) {
        log.warn(
          `${logPrefix}: Long message attachment found no matching place to apply`
        );
      }
    }
    return;
  }

  const maybeReplaceAttachment = (existing: AttachmentType): AttachmentType => {
    if (isDownloaded(existing)) {
      return existing;
    }

    if (attachmentSignature !== getAttachmentSignature(existing)) {
      return existing;
    }

    return attachment;
  };

  if (type === 'attachment') {
    const attachments = message.get('attachments');

    let handledAnywhere = false;
    let handledInEditHistory = false;

    const editHistory = message.get('editHistory');
    if (editHistory) {
      const newEditHistory = editHistory.map(edit => {
        if (!edit.attachments) {
          return edit;
        }

        return {
          ...edit,
          // Loop through all the attachments to find the attachment we intend
          // to replace.
          attachments: edit.attachments.map(item => {
            const newItem = maybeReplaceAttachment(item);
            handledInEditHistory ||= item !== newItem;
            handledAnywhere ||= handledInEditHistory;
            return newItem;
          }),
        };
      });

      if (handledInEditHistory) {
        message.set({ editHistory: newEditHistory });
      }
    }

    if (attachments) {
      message.set({
        attachments: attachments.map(item => {
          const newItem = maybeReplaceAttachment(item);
          handledAnywhere ||= item !== newItem;
          return newItem;
        }),
      });
    }

    if (!handledAnywhere) {
      log.warn(
        `${logPrefix}: 'attachment' type found no matching place to apply`
      );
    }

    return;
  }

  if (type === 'preview') {
    const preview = message.get('preview');

    let handledInEditHistory = false;

    const editHistory = message.get('editHistory');
    if (preview && editHistory) {
      const newEditHistory = editHistory.map(edit => {
        if (!edit.preview) {
          return edit;
        }

        return {
          ...edit,
          preview: edit.preview.map(item => {
            if (!item.image) {
              return item;
            }

            const newImage = maybeReplaceAttachment(item.image);
            handledInEditHistory ||= item.image !== newImage;
            return { ...item, image: newImage };
          }),
        };
      });

      if (handledInEditHistory) {
        message.set({ editHistory: newEditHistory });
      }
    }

    if (preview) {
      message.set({
        preview: preview.map(item => {
          if (!item.image) {
            return item;
          }
          return {
            ...item,
            image: maybeReplaceAttachment(item.image),
          };
        }),
      });
    }

    return;
  }

  if (type === 'contact') {
    const contacts = message.get('contact');
    if (!contacts?.length) {
      throw new Error(`${logPrefix}: no contacts, cannot add attachment!`);
    }
    let handled = false;

    const newContacts = contacts.map(contact => {
      if (!contact.avatar?.avatar) {
        return contact;
      }

      const existingAttachment = contact.avatar.avatar;

      const newAttachment = maybeReplaceAttachment(existingAttachment);
      if (existingAttachment !== newAttachment) {
        handled = true;
        return {
          ...contact,
          avatar: { ...contact.avatar, avatar: newAttachment },
        };
      }
      return contact;
    });

    if (!handled) {
      throw new Error(
        `${logPrefix}: Couldn't find matching contact with avatar attachment for message`
      );
    }

    message.set({ contact: newContacts });
    return;
  }

  if (type === 'quote') {
    const quote = message.get('quote');
    const editHistory = message.get('editHistory');
    let handledInEditHistory = false;
    if (editHistory) {
      const newEditHistory = editHistory.map(edit => {
        if (!edit.quote) {
          return edit;
        }

        return {
          ...edit,
          quote: {
            ...edit.quote,
            attachments: edit.quote.attachments.map(item => {
              const { thumbnail } = item;
              if (!thumbnail) {
                return;
              }

              const newThumbnail = maybeReplaceAttachment(thumbnail);
              if (thumbnail !== newThumbnail) {
                handledInEditHistory = true;
              }
              return { ...item, thumbnail: newThumbnail };
            }),
          },
        };
      });

      if (handledInEditHistory) {
        message.set({ editHistory: newEditHistory });
      }
    }

    if (quote) {
      const newQuote = {
        ...quote,
        attachments: quote.attachments.map(item => {
          const { thumbnail } = item;
          if (!thumbnail) {
            return item;
          }

          return {
            ...item,
            thumbnail: maybeReplaceAttachment(thumbnail),
          };
        }),
      };

      message.set({ quote: newQuote });
    }

    return;
  }

  if (type === 'sticker') {
    const sticker = message.get('sticker');
    if (!sticker) {
      throw new Error(`${logPrefix}: sticker didn't exist`);
    }

    message.set({
      sticker: {
        ...sticker,
        data: attachment,
      },
    });
    return;
  }

  throw new Error(`${logPrefix}: Unknown job type ${type}`);
}
