import React, { FC } from 'react';
import { useTranslation } from 'react-i18next';
import { Label, Button } from '@patternfly/react-core';
import {
  CatalogItem,
  downloadCount,
  ratingAverage,
  openshiftMinors,
} from '../../utils/catalog-types';
import './catalog.css';

const Star: FC<{ filled: boolean; onClick?: () => void; disabled?: boolean }> = ({
  filled,
  onClick,
  disabled,
}) => (
  <button
    type="button"
    className={`ct-star${filled ? ' ct-star--on' : ''}`}
    onClick={onClick}
    disabled={disabled}
    aria-hidden={!onClick}
  >
    ★
  </button>
);

export const ExtensionTile: FC<{
  item: CatalogItem;
  preferPublic: boolean;
  busy: boolean;
  onAdd: () => void;
  onEnable: () => void;
  onUpdate: () => void;
  onChangeVersion: () => void;
  onRemove: () => void;
  onRate: (stars: number) => void;
}> = ({ item, preferPublic, busy, onAdd, onEnable, onUpdate, onRemove, onChangeVersion, onRate }) => {
  const { t } = useTranslation('plugin__oct-storefront');
  const { tool, stats, enabled, installed } = item;
  const avg = ratingAverage(stats, preferPublic);
  const downloads = downloadCount(stats, preferPublic);
  const shown = Math.round(avg);
  const versions = openshiftMinors(tool.spec).join(', ') || t('Unknown');
  const badge = tool.spec.source === 'external' ? t('External') : t('Community');
  const updateVer = item.updateAvailable?.version;
  const canPickVersion = (item.compatibleSemvers || []).length > 1;

  return (
    <article className="ct-tile" id={`ct-tile-${item.id}`}>
      <header className="ct-tile__header">
        <h3 className="ct-tile__title">{tool.spec.displayName}</h3>
        <Label color={tool.spec.source === 'external' ? 'orange' : 'blue'}>{badge}</Label>
      </header>
      <p className="ct-tile__desc">{tool.spec.description}</p>
      <p className="ct-tile__meta">{t('Validated on OpenShift {{versions}}', { versions })}</p>
      {item.installedVersion ? (
        <p className="ct-tile__meta">{t('Installed {{version}}', { version: item.installedVersion })}</p>
      ) : null}
      {updateVer ? (
        <p className="ct-tile__update">{t('Update available ({{version}})', { version: updateVer })}</p>
      ) : null}
      <div className="ct-tile__stats">
        <div className="ct-stars" role="group" aria-label={t('Rating')}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Star key={n} filled={n <= shown} onClick={() => onRate(n)} disabled={busy} />
          ))}
          <span className="ct-tile__stat-text">
            {avg ? avg.toFixed(1) : '—'} ({stats.ratingCount || stats.publicRatingCount || 0})
          </span>
        </div>
        <span className="ct-tile__stat-text">{t('{{count}} downloads', { count: downloads })}</span>
      </div>
      <div className="ct-tile__actions">
        {enabled ? (
          <>
            {tool.spec.href ? (
              <Button variant="link" isInline component="a" href={tool.spec.href}>
                {t('Open')}
              </Button>
            ) : null}
            {updateVer ? (
              <Button variant="link" isInline onClick={onUpdate} isDisabled={busy}>
                {t('Update')}
              </Button>
            ) : null}
            {canPickVersion ? (
              <Button variant="link" isInline onClick={onChangeVersion} isDisabled={busy}>
                {t('Change version')}
              </Button>
            ) : null}
            <Button variant="link" isInline onClick={onRemove} isDisabled={busy}>
              {t('Remove')}
            </Button>
          </>
        ) : installed ? (
          <Button variant="link" isInline onClick={onEnable} isDisabled={busy}>
            {t('Enable')}
          </Button>
        ) : (
          <>
            <Button variant="link" isInline onClick={onAdd} isDisabled={busy}>
              {t('Add')}
            </Button>
            {canPickVersion ? (
              <Button variant="link" isInline onClick={onChangeVersion} isDisabled={busy}>
                {t('Choose version')}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </article>
  );
};

export default ExtensionTile;
