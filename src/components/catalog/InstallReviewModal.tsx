import React, { FC } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  ExpandableSection,
  Label,
  LabelGroup,
  List,
  ListItem,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
  StackItem,
  Title,
} from '@patternfly/react-core';
import { PreparedInstall } from '../../utils/catalog-actions';
import { buildReview, ReviewRule } from '../../utils/review-model';
import { SecurityLevel } from '../../utils/security-profile';
import './catalog.css';

const I18N = 'plugin__oct-storefront';

export const LEVEL_COLOR: Record<SecurityLevel, 'green' | 'blue' | 'teal' | 'orange' | 'red'> = {
  plugin: 'green',
  namespaced: 'blue',
  'cluster-read': 'teal',
  'cluster-write': 'orange',
  privileged: 'red',
};

const Section: FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <StackItem>
    <Title headingLevel="h3" size="md">
      {title}
    </Title>
    {children}
  </StackItem>
);

const Rules: FC<{ rules: ReviewRule[] }> = ({ rules }) => {
  const { t } = useTranslation(I18N);
  return (
    <List isPlain className="ct-review-list">
      {rules.map((r, i) => (
        <ListItem key={`${r.role}-${i}`}>
          <code>{r.text}</code>{' '}
          <span className="ct-review-muted">
            {r.scope === 'cluster' ? t('cluster-wide') : t('in namespace {{ns}}', { ns: r.scope })} · {r.role}
          </span>
          {r.why ? <div className="ct-review-why">{t('Why: {{why}}', { why: r.why })}</div> : null}
        </ListItem>
      ))}
    </List>
  );
};

/**
 * Install review: what the manifests will really do (derived), what the tool says it
 * needs (declared), and what the cluster policy thinks of it. Applying uses exactly
 * the YAML shown here.
 */
export const InstallReviewModal: FC<{
  prep: PreparedInstall | null;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ prep, onConfirm, onCancel }) => {
  const { t } = useTranslation(I18N);
  if (!prep) return null;
  const m = buildReview(prep);
  const { tool, version, action } = prep;
  const name = `${tool.spec.displayName}${version?.version ? ` ${version.version}` : ''}`;
  const verb = action === 'update' ? t('Update') : t('Install');
  const cannotInstall = m.blocked || prep.problems.length > 0;
  const hasPermissionDetails =
    m.clusterRules.length > 0 || m.namespacedRules.length > 0 || m.privileged.length > 0 || m.runtimeCreates.length > 0;

  return (
    <Modal isOpen onClose={onCancel} variant="medium" aria-labelledby="ct-review-title">
      <ModalHeader
        title={action === 'update' ? t('Review update: {{name}}', { name }) : t('Review install: {{name}}', { name })}
        labelId="ct-review-title"
      />
      <ModalBody>
        <Stack hasGutter>
          {prep.policyWarnings.map((w) => (
            <StackItem key={w}>
              <Alert isInline isPlain variant="warning" title={w} />
            </StackItem>
          ))}
          {prep.problems.length ? (
            <StackItem>
              <Alert isInline variant="danger" title={t('This cannot be installed on this cluster')}>
                <List>
                  {prep.problems.map((p) => (
                    <ListItem key={p}>{p}</ListItem>
                  ))}
                </List>
              </Alert>
            </StackItem>
          ) : null}
          {m.reasons.length ? (
            <StackItem>
              <Alert
                isInline
                variant={m.blocked ? 'danger' : 'warning'}
                title={m.blocked ? t('The cluster policy blocks this install') : t('Check before continuing')}
              >
                <List>
                  {m.reasons.map((r) => (
                    <ListItem key={r.id}>{r.message}</ListItem>
                  ))}
                </List>
              </Alert>
            </StackItem>
          ) : null}

          <StackItem>
            <LabelGroup>
              <Label color={LEVEL_COLOR[m.level]}>{t('Level: {{level}}', { level: m.level })}</Label>
              {m.declared ? (
                m.declaredLevel ? (
                  <Label variant="outline">{t('Declared: {{level}}', { level: m.declaredLevel })}</Label>
                ) : null
              ) : (
                <Label variant="outline" color="grey">
                  {t('Not declared')}
                </Label>
              )}
              {tool.spec.source === 'external' ? <Label color="orange">{t('External')}</Label> : null}
              {prep.publicOnly ? <Label color="purple">{t('Public catalog only')}</Label> : null}
            </LabelGroup>
            <p className="ct-review-muted">{m.levelText}</p>
            {m.summary ? <p>{m.summary}</p> : null}
          </StackItem>

          <Section title={t('Capabilities Findings')}>
            {m.findings.length ? (
              <List isPlain className="ct-review-list">
                {m.findings.map((f, i) => (
                  <ListItem key={`${f.id}-${i}`}>
                    <Label isCompact color={f.severity === 'high' ? 'red' : 'orange'}>
                      {f.severity}
                    </Label>{' '}
                    {f.message} <span className="ct-review-muted">({f.object})</span>
                  </ListItem>
                ))}
              </List>
            ) : (
              <p className="ct-review-muted">{t('No findings.')}</p>
            )}
          </Section>
          {hasPermissionDetails ? (
            <StackItem>
              <ExpandableSection toggleText={t('See Permission Details')}>
                <Stack hasGutter>
                  {m.clusterRules.length ? (
                    <Section title={t('Cluster-wide permissions')}>
                      <Rules rules={m.clusterRules} />
                    </Section>
                  ) : null}
                  {m.privileged.length || m.runtimeCreates.length ? (
                    <Section title={t('Privileged access')}>
                      <List isPlain className="ct-review-list">
                        {m.privileged.map((p) => (
                          <ListItem key={p}>{p}</ListItem>
                        ))}
                        {m.runtimeCreates.map((p) => (
                          <ListItem key={p}>{t('Creates at runtime: {{object}}', { object: p })}</ListItem>
                        ))}
                      </List>
                    </Section>
                  ) : null}
                  {m.namespacedRules.length ? (
                    <Section title={t('Namespaced permissions')}>
                      <Rules rules={m.namespacedRules} />
                    </Section>
                  ) : null}
                </Stack>
              </ExpandableSection>
            </StackItem>
          ) : null}

          {action === 'update' ? (
            <Section title={t('Permission changes in this update')}>
              {prep.rbacCompareError ? (
                <p className="ct-review-muted">
                  {t('Could not compare with the installed permissions: {{error}}', { error: prep.rbacCompareError })}
                </p>
              ) : m.rbacAdded.length || m.rbacRemoved.length ? (
                <List isPlain className="ct-review-list">
                  {m.rbacAdded.map((a) => (
                    <ListItem key={`+${a}`}>
                      <strong>+</strong> <code>{a}</code>
                    </ListItem>
                  ))}
                  {m.rbacRemoved.map((a) => (
                    <ListItem key={`-${a}`}>
                      <strong>−</strong> <code>{a}</code>
                    </ListItem>
                  ))}
                </List>
              ) : (
                <p className="ct-review-muted">{t('No permission changes.')}</p>
              )}
            </Section>
          ) : null}

          {m.network.length ? (
            <Section title={t('Network')}>
              <List isPlain className="ct-review-list">
                {m.network.map((n) => (
                  <ListItem key={n}>{n}</ListItem>
                ))}
              </List>
            </Section>
          ) : null}
          {m.images.length ? (
            <Section title={t('Images')}>
              <List isPlain className="ct-review-list">
                {m.images.map((i) => (
                  <ListItem key={i.ref}>
                    <code>{i.ref}</code> <span className="ct-review-muted">{i.note}</span>
                  </ListItem>
                ))}
              </List>
            </Section>
          ) : null}
          <StackItem>
            <ExpandableSection toggleText={t('Everything this creates ({{count}} kinds)', { count: m.kinds.length })}>
              <List isPlain className="ct-review-list">
                {m.kinds.map((k) => (
                  <ListItem key={k}>{k}</ListItem>
                ))}
              </List>
            </ExpandableSection>
          </StackItem>
          <StackItem>
            <ExpandableSection toggleText={t('Show the YAML that will be applied')}>
              <pre className="ct-yaml ct-review-yaml">{prep.yaml}</pre>
            </ExpandableSection>
          </StackItem>
          {m.contact ? (
            <StackItem className="ct-review-muted">{t('Security contact: {{contact}}', { contact: m.contact })}</StackItem>
          ) : null}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button variant={cannotInstall ? 'secondary' : 'primary'} onClick={onConfirm} isDisabled={cannotInstall}>
          {verb}
        </Button>
        <Button variant="link" onClick={onCancel}>
          {t('Cancel')}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export default InstallReviewModal;
