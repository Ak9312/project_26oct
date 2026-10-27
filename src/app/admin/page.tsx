import type { Metadata } from "next";
import { adminConfigured } from "@/lib/auth";
import AdminDashboard from "@/components/admin-dashboard";
import { SiteHeader } from "@/components/site-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Admin · Policy Knowledge Assistant",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * Only reachable through the secret ADMIN_PATH URL (see src/proxy.ts),
 * which also issues the admin session cookie.
 */
export default function AdminPage() {
  if (!adminConfigured()) {
    return (
      <div className="min-h-dvh bg-muted/40">
        <SiteHeader title="Policy Knowledge Assistant" tag="Admin" />
        <main className="mx-auto max-w-lg px-4 py-16">
          <Card>
            <CardHeader>
              <CardTitle>Admin isn&apos;t set up yet</CardTitle>
              <CardDescription>
                Add an <code className="rounded bg-muted px-1 py-0.5 text-foreground">ADMIN_PATH</code> environment variable (at least 8 random
                characters) in your Vercel project settings, then redeploy. The admin page will be at that path.
              </CardDescription>
            </CardHeader>
            <CardContent />
          </Card>
        </main>
      </div>
    );
  }
  return <AdminDashboard />;
}
