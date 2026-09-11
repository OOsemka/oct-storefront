import React, { FC } from 'react';
import { DocumentTitle } from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Card,
  CardBody,
  CardTitle,
  Content,
  ContentVariants,
  PageSection,
  Stack,
  StackItem,
  Title,
} from '@patternfly/react-core';
import { ExternalLinkAltIcon } from '@patternfly/react-icons';
import CommunityDisclaimer from './CommunityDisclaimer';
import './StorefrontAboutPage.css';

const I18N = 'plugin__oct-storefront';
const STOREFRONT_VERSION = '1.2.4';

const StorefrontAboutPage: FC = () => {
  const { t } = useTranslation(I18N);

  return (
    <>
      <DocumentTitle>{t('About OpenShift Community Tools')}</DocumentTitle>
      <PageSection>
        <Stack hasGutter>
          <StackItem>
            <Title headingLevel="h1">{t('About OpenShift Community Tools')}</Title>
          </StackItem>
          <StackItem>
            <CommunityDisclaimer />
          </StackItem>

          <StackItem>
            <Card className="ct-about-card">
              <CardTitle>{t('What is OCT?')}</CardTitle>
              <CardBody>
                <Stack hasGutter>
                  <StackItem>
                    <Content component={ContentVariants.p}>
                      {t(
                        'OpenShift Community Tools (OCT) is a set of community-built UX extensions for the OpenShift Console. Extensions are installed and managed through this storefront — browse categories, add tools with one click, and keep them updated.',
                      )}
                    </Content>
                  </StackItem>
                  <StackItem>
                    <Content component={ContentVariants.p} className="ct-about-version">
                      {t('Storefront version: {{version}}', { version: STOREFRONT_VERSION })}
                    </Content>
                  </StackItem>
                  <StackItem className="ct-about-links">
                    <Button
                      variant="link"
                      isInline
                      component="a"
                      href="https://octools.net"
                      target="_blank"
                      rel="noopener noreferrer"
                      icon={<ExternalLinkAltIcon />}
                      iconPosition="end"
                    >
                      {t('Visit octools.net for documentation and developer guides')}
                    </Button>
                  </StackItem>
                  <StackItem className="ct-about-links">
                    <Button
                      variant="link"
                      isInline
                      component="a"
                      href="https://github.com/OOsemka/oct-storefront"
                      target="_blank"
                      rel="noopener noreferrer"
                      icon={<ExternalLinkAltIcon />}
                      iconPosition="end"
                    >
                      {t('Source code on GitHub')}
                    </Button>
                  </StackItem>
                  <StackItem className="ct-about-links">
                    <Button
                      variant="link"
                      isInline
                      component="a"
                      href="https://api.octools.net"
                      target="_blank"
                      rel="noopener noreferrer"
                      icon={<ExternalLinkAltIcon />}
                      iconPosition="end"
                    >
                      {t('Public stats API at api.octools.net')}
                    </Button>
                  </StackItem>
                </Stack>
              </CardBody>
            </Card>
          </StackItem>

          <StackItem>
            <Card className="ct-about-card">
              <CardTitle>{t('Storefront updates')}</CardTitle>
              <CardBody>
                <Content component={ContentVariants.p}>
                  {t(
                    'This tile tracks storefront updates. When a new version is available, use the Update button on the Management hub to upgrade.',
                  )}
                </Content>
              </CardBody>
            </Card>
          </StackItem>
        </Stack>
      </PageSection>
    </>
  );
};

export default StorefrontAboutPage;
