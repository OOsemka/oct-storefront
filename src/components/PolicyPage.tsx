import React, { FC, useCallback, useEffect, useState } from 'react';
import { DocumentTitle } from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';
import { ExternalLinkAltIcon } from '@patternfly/react-icons';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardTitle,
  CodeBlock,
  CodeBlockCode,
  Content,
  ContentVariants,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Label,
  LabelProps,
  List,
  ListItem,
  PageSection,
  Spinner,
  Stack,
  StackItem,
  Title,
} from '@patternfly/react-core';
import { loadPolicyView, PolicyView } from '../utils/catalog-actions';
import { POLICY_CONFIGMAP } from '../utils/policy';
import {
  ADMISSION_PARAMS_CONFIGMAP,
  admissionStatus,
  AdmissionState,
  backendRows,
  BindingMode,
  EMPTY_MEANS,
  SettingKey,
  settingRows,
  toolOverrideRows,
} from '../utils/policy-view';
import { STOREFRONT_NS } from '../utils/catalog-types';
import './PolicyPage.css';

/** The admin guide for everything on this page (docs/security-guide.md). */
const SECURITY_GUIDE_URL = 'https://github.com/openshift-community-tools/oct-storefront/blob/main/docs/security-guide.md';

const I18N = 'plugin__oct-storefront';

/** Read-only view of the cluster policy and the admission policy pack. Changing either needs oc and a cluster admin. */
const PolicyPage: FC = () => {
  const { t } = useTranslation(I18N);
  const [view, setView] = useState<PolicyView | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    loadPolicyView()
      .then(setView)
      .finally(() => setLoading(false));
  }, []);
  useEffect(refresh, [refresh]);

  const describe: Record<SettingKey, string> = {
    mode: t('off: never warn or block. warn: show reasons, never block. enforce: block installs that break a rule.'),
    review: t('When the install review screen is shown: never, elevated (anything beyond a plain plugin) or always.'),
    maxLevel: t('Highest derived privilege level a tool may have.'),
    external: t('Tools pasted in with Add external: allow, review or block.'),
    externalMaxLevel: t('Highest privilege level for external tools.'),
    publicCatalog: t('Public catalog sync from api.octools.net: full, metadata-only or off.'),
    rbacWidening: t('Updates that add RBAC permissions: allow, warn, review or block.'),
    allowRoutes: t('Whether tools may create Routes (expose a service outside the cluster).'),
    requireNetworkPolicy: t('Whether backends behind the console proxy must ship a NetworkPolicy.'),
    allowedRegistries: t('Image registries tools may use (prefix match).'),
    requireDigest: t('Which tools must pin images by digest: none, community or all.'),
    allowedDeployHosts: t('Hosts a deployURL may point at.'),
    telemetry: t('Usage data sent to api.octools.net: full, ratings-only or off.'),
  };

  const shown = (key: SettingKey, value: string): string => {
    if (value) return value;
    if (EMPTY_MEANS[key] === 'no-limit') return t('no limit');
    if (EMPTY_MEANS[key] === 'any') return t('any');
    return t('not set');
  };

  const sourceLabel = (): { color: LabelProps['color']; text: string } => {
    if (!view || view.source === 'default') return { color: 'grey', text: t('Defaults (no policy ConfigMap)') };
    if (view.source === 'configmap') {
      return { color: 'blue', text: t('ConfigMap {{ns}}/{{name}}', { ns: STOREFRONT_NS, name: POLICY_CONFIGMAP }) };
    }
    return { color: 'red', text: t('Could not read the policy: defaults apply') };
  };

  const stateLabel = (state: AdmissionState): { color: LabelProps['color']; text: string } => {
    switch (state) {
      case 'enforce':
        return { color: 'green', text: t('Enforce: violations are rejected') };
      case 'warn':
        return { color: 'blue', text: t('Warn: violations are reported, not blocked') };
      case 'audit':
        return { color: 'blue', text: t('Audit only: violations go to the API audit log') };
      case 'mixed':
        return { color: 'orange', text: t('Mixed: policies are in different modes') };
      case 'partial':
        return { color: 'orange', text: t('Partly installed') };
      case 'not-installed':
        return { color: 'grey', text: t('Not installed') };
      default:
        return { color: 'grey', text: t('Not visible with your permissions') };
    }
  };

  const modeText = (mode: BindingMode): string =>
    ({
      enforce: t('enforce'),
      warn: t('warn'),
      audit: t('audit'),
      missing: t('not installed'),
    })[mode];

  if (loading && !view) {
    return (
      <PageSection>
        <Spinner aria-label={t('Loading')} />
      </PageSection>
    );
  }

  const rows = view ? settingRows(view.policy) : [];
  const overrides = view ? toolOverrideRows(view.policy) : [];
  const backends = view ? backendRows(view.policy) : [];
  const admission = admissionStatus(view?.admissionBindings ?? null);
  const src = sourceLabel();
  const adm = stateLabel(admission.state);
  const params = view?.admissionParams;

  return (
    <>
      <DocumentTitle>{t('Cluster policy')}</DocumentTitle>
      <PageSection>
        <Stack hasGutter>
          <StackItem>
            <Title headingLevel="h1">{t('Cluster policy')}</Title>
            <Content component={ContentVariants.p}>
              {t(
                'Read-only view of the settings that decide what this storefront offers and how installs are reviewed. A cluster admin changes them with oc (see below).',
              )}{' '}
              <Button variant="link" isInline onClick={refresh} isLoading={loading} isDisabled={loading}>
                {t('Refresh')}
              </Button>
            </Content>
            <Content component={ContentVariants.p}>
              <Button
                variant="link"
                isInline
                component="a"
                href={SECURITY_GUIDE_URL}
                target="_blank"
                rel="noopener noreferrer"
                icon={<ExternalLinkAltIcon />}
                iconPosition="end"
              >
                {t('Security guide: install review, policy examples, turning on enforcement')}
              </Button>
            </Content>
          </StackItem>

          <StackItem>
            <Card>
              <CardTitle>{t('Storefront policy')}</CardTitle>
              <CardBody>
                <Stack hasGutter>
                  <StackItem>
                    {t('Source:')} <Label color={src.color}>{src.text}</Label>
                  </StackItem>
                  {view?.warnings.length ? (
                    <StackItem>
                      <Alert isInline variant="warning" title={t('Problems in the policy')}>
                        <List>
                          {view.warnings.map((w) => (
                            <ListItem key={w}>{w}</ListItem>
                          ))}
                        </List>
                      </Alert>
                    </StackItem>
                  ) : null}
                  <StackItem>
                    <Content component={ContentVariants.small}>
                      {t(
                        'Advisory: the storefront applies manifests with your own permissions, so these settings control what it offers, not what you could apply by hand. Hard limits come from RBAC and the admission policy pack.',
                      )}
                    </Content>
                  </StackItem>
                  <StackItem>
                    <DescriptionList isHorizontal className="ct-policy-list">
                      {rows.map((r) => (
                        <DescriptionListGroup key={r.key}>
                          <DescriptionListTerm>
                            <code>{r.key}</code>
                            <div className="ct-policy-help">{describe[r.key]}</div>
                          </DescriptionListTerm>
                          <DescriptionListDescription>
                            <code>{shown(r.key, r.value)}</code>{' '}
                            {r.changed ? (
                              <>
                                <Label color="blue" isCompact>
                                  {t('changed')}
                                </Label>{' '}
                                <span className="ct-policy-help">
                                  {t('default: {{value}}', { value: shown(r.key, r.defaultValue) })}
                                </span>
                              </>
                            ) : null}
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                      ))}
                    </DescriptionList>
                  </StackItem>
                </Stack>
              </CardBody>
            </Card>
          </StackItem>

          <StackItem>
            <Card>
              <CardTitle>{t('Per-tool exceptions')}</CardTitle>
              <CardBody>
                {overrides.length ? (
                  <DescriptionList isHorizontal isCompact className="ct-policy-names">
                    {overrides.map((o) => (
                      <DescriptionListGroup key={o.tool}>
                        <DescriptionListTerm>
                          <code>{o.tool}</code>
                        </DescriptionListTerm>
                        <DescriptionListDescription>
                          <code>{o.overrides}</code>
                        </DescriptionListDescription>
                      </DescriptionListGroup>
                    ))}
                  </DescriptionList>
                ) : (
                  <Content component={ContentVariants.p}>{t('None: every tool follows the settings above.')}</Content>
                )}
              </CardBody>
            </Card>
          </StackItem>

          <StackItem>
            <Card>
              <CardTitle>{t('Extension backend auth modes')}</CardTitle>
              <CardBody>
                {backends.length ? (
                  <DescriptionList isHorizontal isCompact className="ct-policy-names">
                    {backends.map((b) => (
                      <DescriptionListGroup key={b.extension}>
                        <DescriptionListTerm>
                          <code>{b.extension}</code>
                        </DescriptionListTerm>
                        <DescriptionListDescription>
                          <Label color={b.authMode === 'enforce' ? 'green' : 'blue'} isCompact>
                            {b.authMode}
                          </Label>
                        </DescriptionListDescription>
                      </DescriptionListGroup>
                    ))}
                  </DescriptionList>
                ) : (
                  <Content component={ContentVariants.p}>
                    {t(
                      'None set: each backend uses the mode it ships with. Existing extensions ship in audit (requests allowed, would-be denials logged); new extensions ship in enforce.',
                    )}
                  </Content>
                )}
              </CardBody>
            </Card>
          </StackItem>

          <StackItem>
            <Card>
              <CardTitle>{t('Admission policy pack')}</CardTitle>
              <CardBody>
                <Stack hasGutter>
                  <StackItem>
                    <Content component={ContentVariants.p}>
                      {t(
                        'Optional ValidatingAdmissionPolicies enforced by the API server, so they also apply to YAML applied by hand. They check objects with the communitytools.io/extension label and requests from service accounts in oct-* namespaces.',
                      )}
                    </Content>
                  </StackItem>
                  <StackItem>
                    {t('State:')} <Label color={adm.color}>{adm.text}</Label>
                  </StackItem>
                  {admission.state !== 'unknown' && admission.state !== 'not-installed' ? (
                    <StackItem>
                      <DescriptionList isHorizontal isCompact className="ct-policy-names">
                        {admission.policies.map((p) => (
                          <DescriptionListGroup key={p.name}>
                            <DescriptionListTerm>
                              <code>{p.name}</code>
                            </DescriptionListTerm>
                            <DescriptionListDescription>{modeText(p.mode)}</DescriptionListDescription>
                          </DescriptionListGroup>
                        ))}
                      </DescriptionList>
                    </StackItem>
                  ) : null}
                  {params?.state === 'present' && params.params ? (
                    <StackItem>
                      <Title headingLevel="h3" size="md">
                        {t('Settings ({{ns}}/{{name}})', { ns: STOREFRONT_NS, name: ADMISSION_PARAMS_CONFIGMAP })}
                      </Title>
                      <DescriptionList isHorizontal isCompact className="ct-policy-names">
                        <DescriptionListGroup>
                          <DescriptionListTerm>
                            <code>allowedRegistries</code>
                          </DescriptionListTerm>
                          <DescriptionListDescription>
                            <code>{params.params.allowedRegistries.join(', ') || t('any')}</code>
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>
                            <code>requireDigest</code>
                          </DescriptionListTerm>
                          <DescriptionListDescription>
                            <code>{String(params.params.requireDigest)}</code>
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>
                            <code>approvedRoutes</code>
                          </DescriptionListTerm>
                          <DescriptionListDescription>
                            <code>{params.params.approvedRoutes.join(', ') || t('none')}</code>
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>
                            <code>approvedSCCs</code>
                          </DescriptionListTerm>
                          <DescriptionListDescription>
                            <code>{params.params.approvedSCCs.join(', ') || t('none')}</code>
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>
                            <code>approvedSCCBindings</code>
                          </DescriptionListTerm>
                          <DescriptionListDescription>
                            <code>{params.params.approvedSCCBindings.join(', ') || t('none')}</code>
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                      </DescriptionList>
                    </StackItem>
                  ) : null}
                  {params?.state === 'missing' && admission.state !== 'not-installed' ? (
                    <StackItem>
                      <Alert isInline variant="warning" title={t('Admission settings ConfigMap missing')}>
                        {t(
                          'Without {{name}}, the image, Route and SCC rules are skipped. The role-binding rule still applies.',
                          { name: ADMISSION_PARAMS_CONFIGMAP },
                        )}
                      </Alert>
                    </StackItem>
                  ) : null}
                  {params?.state === 'hidden' && admission.state !== 'unknown' ? (
                    <StackItem>
                      <Content component={ContentVariants.small}>
                        {t('The admission settings are not visible with your permissions.')}
                      </Content>
                    </StackItem>
                  ) : null}
                </Stack>
              </CardBody>
            </Card>
          </StackItem>

          <StackItem>
            <Card>
              <CardTitle>{t('How to change these settings')}</CardTitle>
              <CardBody>
                <Stack hasGutter>
                  <StackItem>
                    <Content component={ContentVariants.p}>
                      {t(
                        'As a cluster admin. The policy file, with every setting explained, is deploy/policy/community-tools-policy.yaml in the oct-storefront repository; the admission pack is in deploy/policy/vap.',
                      )}
                    </Content>
                  </StackItem>
                  <StackItem>
                    <CodeBlock>
                      <CodeBlockCode>{`# Storefront policy
oc apply -f community-tools-policy.yaml
oc -n ${STOREFRONT_NS} edit configmap ${POLICY_CONFIGMAP}
oc -n ${STOREFRONT_NS} delete configmap ${POLICY_CONFIGMAP}   # back to the defaults

# Admission policy pack
oc create -f deploy/policy/vap/params.yaml       # settings, once
oc apply -k deploy/policy/vap                    # warn
oc apply -k deploy/policy/vap/enforce            # enforce
oc -n ${STOREFRONT_NS} edit configmap ${ADMISSION_PARAMS_CONFIGMAP}`}</CodeBlockCode>
                    </CodeBlock>
                  </StackItem>
                </Stack>
              </CardBody>
            </Card>
          </StackItem>
        </Stack>
      </PageSection>
    </>
  );
};

export default PolicyPage;
