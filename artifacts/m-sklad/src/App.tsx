import { Switch, Route, Redirect, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import AccessDenied from "@/components/AccessDenied";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import Items from "@/pages/items";
import Categories from "@/pages/categories";
import Receipts from "@/pages/receipts";
import WriteOffs from "@/pages/write-offs";
import InventoryAudits, { InventoryAuditSheet } from "@/pages/inventory-audits";
import Staff from "@/pages/staff";
import AuditLog from "@/pages/audit-log";
import Settings from "@/pages/settings";
import Rentals from "@/pages/rentals";
import Onboarding from "@/pages/onboarding";
import Reports from "@/pages/reports";
import Transfers from "@/pages/transfers";
import Houses from "@/pages/houses";
import Registers from "@/pages/registers";
import Shifts from "@/pages/shifts";
import KassaDashboard from "@/pages/kassa-dashboard";
import KassaReports from "@/pages/kassa-reports";
import KassaCosting from "@/pages/kassa-costing";
import { LoginPage, SetupPage } from "@/pages/login";
import { TechCardsList, TechCardDetail, TechCardEditor } from "@/pages/tech-cards";
import Productions from "@/pages/productions";
import SalesMargin from "@/pages/sales-margin";
import Counterparties, { CounterpartyCard } from "@/pages/counterparties";
import { AppLayout } from "@/components/layout";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import type { AppRole } from "@/hooks/useCurrentUser";
import { useAuthState } from "@/hooks/useAuthState";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function Spinner() {
  return <div className="min-h-[100dvh] flex items-center justify-center bg-background"><div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" /></div>;
}

/** Signed-out visitors go to /setup on a fresh install, otherwise to /login. */
function SignedOutRedirect() {
  const { needsSetup } = useAuthState();
  return <Redirect to={needsSetup ? "/setup" : "/login"} />;
}

function HomeRedirect() {
  const { isLoading, isSignedIn } = useAuthState();
  if (isLoading) return <Spinner />;
  return isSignedIn ? <Redirect to="/dashboard" /> : <SignedOutRedirect />;
}

function PublicOnly({ component: Component }: { component: React.ComponentType }) {
  const { isLoading, isSignedIn } = useAuthState();
  if (isLoading) return <Spinner />;
  if (isSignedIn) return <Redirect to="/dashboard" />;
  return <Component />;
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { isLoading, isSignedIn } = useAuthState();
  if (isLoading) return <Spinner />;
  if (!isSignedIn) return <SignedOutRedirect />;
  return <AppLayout><Component /></AppLayout>;
}

function RoleCheck({ component: Component, minRole, domain = "warehouse" }: { component: React.ComponentType; minRole: AppRole; domain?: "warehouse" | "venue" }) {
  const { canDo, canDoVenue, isLoading } = useCurrentUser();
  if (isLoading) return <Spinner />;
  const allowed = domain === "venue" ? canDoVenue(minRole) : canDo(minRole);
  if (!allowed) return <AppLayout><AccessDenied /></AppLayout>;
  return <AppLayout><Component /></AppLayout>;
}

function RoleProtectedRoute({ component, minRole, domain }: { component: React.ComponentType; minRole: AppRole; domain?: "warehouse" | "venue" }) {
  const { isLoading, isSignedIn } = useAuthState();
  if (isLoading) return <Spinner />;
  if (!isSignedIn) return <SignedOutRedirect />;
  return <RoleCheck component={component} minRole={minRole} domain={domain} />;
}

function OnboardingPage() {
  const { isLoading, isSignedIn } = useAuthState();
  if (isLoading) return <Spinner />;
  if (!isSignedIn) return <SignedOutRedirect />;
  return <Onboarding />;
}

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 0, refetchOnMount: true, refetchOnWindowFocus: true } } });

function Routes() {
  return (
    <Switch>
      <Route path="/" component={HomeRedirect} />
      <Route path="/login"><PublicOnly component={LoginPage} /></Route>
      <Route path="/setup"><PublicOnly component={SetupPage} /></Route>
      <Route path="/dashboard"><ProtectedRoute component={Dashboard} /></Route>
      <Route path="/items"><ProtectedRoute component={Items} /></Route>
      <Route path="/tech-cards"><ProtectedRoute component={TechCardsList} /></Route>
      <Route path="/tech-cards/new"><ProtectedRoute component={TechCardEditor} /></Route>
      <Route path="/tech-cards/:id/edit"><ProtectedRoute component={TechCardEditor} /></Route>
      <Route path="/tech-cards/:id"><ProtectedRoute component={TechCardDetail} /></Route>
      <Route path="/productions"><ProtectedRoute component={Productions} /></Route>
      <Route path="/counterparties"><ProtectedRoute component={Counterparties} /></Route>
      <Route path="/counterparties/:id"><ProtectedRoute component={CounterpartyCard} /></Route>
      <Route path="/transfers"><ProtectedRoute component={Transfers} /></Route>
      <Route path="/houses"><RoleProtectedRoute component={Houses} minRole="location_admin" domain="venue" /></Route>
      <Route path="/registers"><RoleProtectedRoute component={Registers} minRole="location_admin" domain="venue" /></Route>
      <Route path="/shifts"><RoleProtectedRoute component={Shifts} minRole="cashier" domain="venue" /></Route>
      <Route path="/kassa-dashboard"><RoleProtectedRoute component={KassaDashboard} minRole="location_admin" domain="venue" /></Route>
      <Route path="/kassa-reports"><RoleProtectedRoute component={KassaReports} minRole="location_admin" domain="venue" /></Route>
      <Route path="/sales-margin"><RoleProtectedRoute component={SalesMargin} minRole="location_admin" domain="venue" /></Route>
      <Route path="/kassa-costing"><RoleProtectedRoute component={KassaCosting} minRole="location_admin" domain="venue" /></Route>
      <Route path="/categories"><RoleProtectedRoute component={Categories} minRole="manager" /></Route>
      <Route path="/receipts"><ProtectedRoute component={Receipts} /></Route>
      <Route path="/write-offs"><RoleProtectedRoute component={WriteOffs} minRole="accountant" /></Route>
      <Route path="/inventory-audits"><ProtectedRoute component={InventoryAudits} /></Route>
      <Route path="/inventory-audits/:id"><ProtectedRoute component={InventoryAuditSheet} /></Route>
      <Route path="/rentals"><ProtectedRoute component={Rentals} /></Route>
      <Route path="/staff"><RoleProtectedRoute component={Staff} minRole="manager" /></Route>
      <Route path="/audit-log"><ProtectedRoute component={AuditLog} /></Route>
      <Route path="/reports"><RoleProtectedRoute component={Reports} minRole="warehouse_chief" /></Route>
      <Route path="/settings"><ProtectedRoute component={Settings} /></Route>
      <Route path="/onboarding"><OnboardingPage /></Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <TooltipProvider>
      <QueryClientProvider client={queryClient}>
        <WouterRouter base={basePath}>
          <Routes />
        </WouterRouter>
      </QueryClientProvider>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
