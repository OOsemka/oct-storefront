import React, { FC } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@patternfly/react-core';
import './CommunityDisclaimer.css';

/** Shared community / support banner. Use on hub pages and tool headers. */
const CommunityDisclaimer: FC = () => {
  const { t } = useTranslation('plugin__oct-storefront');

  return (
    <Alert
      className="ct-community-disclaimer"
      variant="info"
      isInline
      title={t('Community project. Not officially supported by Red Hat.')}
    >
      {t('OpenShift Community Tools is unofficial UX enhancements for the OpenShift Console.')}{' '}
      {t(
        'Download counts and anonymous star ratings are collected to improve the catalog. No personal data or cluster identifiers are stored.',
      )}
    </Alert>
  );
};

export default CommunityDisclaimer;
