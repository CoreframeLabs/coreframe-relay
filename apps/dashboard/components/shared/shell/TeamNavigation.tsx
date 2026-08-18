import {
  Cog6ToothIcon,
  ArrowsRightLeftIcon,
  QueueListIcon,
  ArchiveBoxIcon,
} from '@heroicons/react/24/outline';
import { useTranslation } from 'next-i18next';
import NavigationItems from './NavigationItems';
import { NavigationProps, MenuItem } from './NavigationItems';

interface NavigationItemsProps extends NavigationProps {
  slug: string;
}

/**
 * The BoxyHQ starter-kit shipped this as a single dead "All Products" link to
 * `/teams/[slug]/products`, whose entire page body is the literal string
 * `t('product-placeholder')` -- nobody ever replaced it with real navigation
 * to the Relay product. There was consequently no way to reach Buffer's three
 * real surfaces (Routes, Delivery Log, DLQ) from the UI at all, only by
 * typing the URL directly -- which is exactly why this went uncaught: every
 * automated check (Playwright, curl) navigates straight to a known path and
 * never exercises the primary nav a real signup actually lands on.
 */
const TeamNavigation = ({ slug, activePathname }: NavigationItemsProps) => {
  const { t } = useTranslation('common');

  const menus: MenuItem[] = [
    {
      name: 'Routes',
      href: `/teams/${slug}/relay/buffer`,
      icon: ArrowsRightLeftIcon,
      active: activePathname === `/teams/${slug}/relay/buffer`,
    },
    {
      name: 'Delivery Log',
      href: `/teams/${slug}/relay/buffer/log`,
      icon: QueueListIcon,
      active: activePathname === `/teams/${slug}/relay/buffer/log`,
    },
    {
      name: 'DLQ',
      href: `/teams/${slug}/relay/buffer/dlq`,
      icon: ArchiveBoxIcon,
      active: activePathname === `/teams/${slug}/relay/buffer/dlq`,
    },
    {
      name: t('settings'),
      href: `/teams/${slug}/settings`,
      icon: Cog6ToothIcon,
      active:
        !!activePathname?.startsWith(`/teams/${slug}`) &&
        !activePathname.includes('/relay/'),
    },
  ];

  return <NavigationItems menus={menus} />;
};

export default TeamNavigation;
