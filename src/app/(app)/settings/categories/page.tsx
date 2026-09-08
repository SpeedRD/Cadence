import { ChevronLeft } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { CategoryManager } from "@/components/settings/category-manager";
import { Button } from "@/components/ui/button";
import { getAppContext } from "@/lib/data/context";
import { listCategoriesWithUsage } from "@/lib/data/categories";
import { getDictionary } from "@/lib/i18n";

export const metadata = { title: "Categories - Cadence" };

export default async function CategoriesPage() {
  const context = await getAppContext();
  const t = getDictionary(context.language).settingsPage;
  const nav = getDictionary(context.language).nav;
  const categories = await listCategoriesWithUsage();

  return (
    <div className="space-y-5">
      <Button asChild variant="ghost" size="xs" className="-ml-2">
        <Link href="/settings">
          <ChevronLeft className="size-3.5" />
          {nav.settings}
        </Link>
      </Button>

      <PageHeader title={t.categoriesTitle} description={t.categoriesPageDescription} />

      <CategoryManager categories={categories} locale={context.language} />
    </div>
  );
}
