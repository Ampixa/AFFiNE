import {
  type InviteLink,
  WorkspaceInviteLinkExpireTime,
} from '@affine/graphql';
import { useI18n } from '@affine/i18n';
import { CloseIcon } from '@blocksuite/icons/rc';
import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button, IconButton } from '../../../ui/button';
import Input from '../../../ui/input';
import { Menu, MenuItem, MenuTrigger } from '../../../ui/menu';
import { notify } from '../../../ui/notification';
import { scheduleAt } from '../../../utils/schedule-at';
import * as styles from './styles.css';

const getMenuItems = (t: ReturnType<typeof useI18n>) => [
  {
    label: t['com.affine.payment.member.team.invite.expiration-date']({
      number: '1',
    }),
    value: WorkspaceInviteLinkExpireTime.OneDay,
  },
  {
    label: t['com.affine.payment.member.team.invite.expiration-date']({
      number: '3',
    }),
    value: WorkspaceInviteLinkExpireTime.ThreeDays,
  },
  {
    label: t['com.affine.payment.member.team.invite.expiration-date']({
      number: '7',
    }),
    value: WorkspaceInviteLinkExpireTime.OneWeek,
  },
  {
    label: t['com.affine.payment.member.team.invite.expiration-date']({
      number: '30',
    }),
    value: WorkspaceInviteLinkExpireTime.OneMonth,
  },
];

export const LinkInvite = ({
  invitationLink,
  copyTextToClipboard,
  generateInvitationLink,
  revokeInvitationLink,
}: {
  invitationLink: InviteLink | null;
  generateInvitationLink: (
    expireTime: WorkspaceInviteLinkExpireTime
  ) => Promise<InviteLink>;
  revokeInvitationLink: () => Promise<boolean>;
  copyTextToClipboard: (text: string) => Promise<boolean>;
}) => {
  const t = useI18n();
  const [generatedInvitationLink, setGeneratedInvitationLink] =
    useState<InviteLink | null>(null);
  const activeInvitationLink = invitationLink ?? generatedInvitationLink;

  useEffect(() => {
    if (!generatedInvitationLink) {
      return;
    }
    return scheduleAt(
      new Date(generatedInvitationLink.expireTime).getTime(),
      () => setGeneratedInvitationLink(null)
    );
  }, [generatedInvitationLink]);
  const [selectedValue, setSelectedValue] = useState(
    WorkspaceInviteLinkExpireTime.OneWeek
  );
  const menuItems = getMenuItems(t);
  const items = useMemo(() => {
    return menuItems.map(item => (
      <MenuItem key={item.value} onSelect={() => setSelectedValue(item.value)}>
        {item.label}
      </MenuItem>
    ));
  }, [menuItems]);

  const currentSelectedLabel = useMemo(
    () => menuItems.find(item => item.value === selectedValue)?.label,
    [menuItems, selectedValue]
  );

  const onGenerate = useCallback(async () => {
    try {
      const link = await generateInvitationLink(selectedValue);
      setGeneratedInvitationLink(link);
    } catch (err) {
      console.error('Failed to generate invitation link: ', err);
      notify.error({
        title: 'Failed to generate invitation link',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [generateInvitationLink, selectedValue]);

  const onCopy = useCallback(() => {
    if (!activeInvitationLink) {
      return;
    }
    copyTextToClipboard(activeInvitationLink.link)
      .then(() =>
        notify.success({
          title: t['Copied link to clipboard'](),
        })
      )
      .catch(err => {
        console.error('Failed to copy text: ', err);
        notify.error({
          title: 'Failed to copy link to clipboard',
          message: err.message,
        });
      });
  }, [activeInvitationLink, copyTextToClipboard, t]);

  const onReset = useCallback(async () => {
    try {
      const revoked = await revokeInvitationLink();
      if (revoked) {
        setGeneratedInvitationLink(null);
      }
    } catch (err) {
      console.error('Failed to revoke invitation link: ', err);
      notify.error({
        title: 'Failed to revoke invitation link',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [revokeInvitationLink]);

  const expireTime = useMemo(() => {
    return t['com.affine.payment.member.team.invite.expire-at']({
      expireTime: activeInvitationLink?.expireTime
        ? new Date(activeInvitationLink.expireTime).toLocaleString()
        : '',
    });
  }, [activeInvitationLink, t]);

  return (
    <>
      <div className={styles.invitationLinkContainer}>
        <div className={styles.modalSubTitle}>
          {t['com.affine.payment.member.team.invite.link-expiration']()}
        </div>
        {activeInvitationLink ? (
          <Input
            value={expireTime}
            disabled
            style={{
              backgroundColor: cssVarV2('input/background'),
            }}
          />
        ) : (
          <Menu
            items={items}
            contentOptions={{
              style: {
                width: 'var(--radix-dropdown-menu-trigger-width)',
              },
            }}
          >
            <MenuTrigger style={{ width: '100%' }}>
              {currentSelectedLabel}
            </MenuTrigger>
          </Menu>
        )}
      </div>
      <div className={styles.invitationLinkContainer}>
        <div className={styles.modalSubTitle}>
          {t['com.affine.payment.member.team.invite.invitation-link']()}
        </div>
        <div className={styles.invitationLinkContent}>
          <Input
            value={
              activeInvitationLink
                ? activeInvitationLink.link
                : 'https://your-app.com/invite/xxxxxxxx'
            }
            inputMode="none"
            disabled
            inputStyle={{
              fontSize: cssVar('fontXs'),
              color: cssVarV2(
                activeInvitationLink ? 'text/primary' : 'text/placeholder'
              ),
              backgroundColor: cssVarV2('layer/background/primary'),
            }}
          />
          {activeInvitationLink ? (
            <>
              <Button onClick={onCopy} variant="secondary">
                {t['com.affine.payment.member.team.invite.copy']()}
              </Button>
              <IconButton icon={<CloseIcon />} onClick={() => void onReset()} />
            </>
          ) : (
            <Button onClick={() => void onGenerate()} variant="secondary">
              {t['com.affine.payment.member.team.invite.generate']()}
            </Button>
          )}
        </div>
        <p className={styles.invitationLinkDescription}>
          {t[
            'com.affine.payment.member.team.invite.invitation-link.description'
          ]()}
        </p>
      </div>
    </>
  );
};
