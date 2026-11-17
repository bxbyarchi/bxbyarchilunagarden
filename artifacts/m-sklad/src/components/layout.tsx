import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useGetMe } from "@workspace/api-client-react";
import { useSignOut, BRAND_NAME } from "@/hooks/useAuthState";
import { LayoutDashboard, Package, Tags, ArrowDownToLine, ArrowUpFromLine, ClipboardCheck, Users, History, Settings, LogOut, KeyRound, FileBarChart, Menu, X, MapPin, Truck, Home, Unlock, PieChart, Calculator, ChefHat, Factory, TrendingUp, Contact, BarChart3, CalendarDays, UserRound, Bot, CalendarRange, Clock, ScanFace, ListTodo, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ROLE_LABELS } from "@/lib/roles";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { data: user } = useGetMe();
  const signOut = useSignOut();
  const isVenueOnly = user?.role === "location_admin" || user?.role === "cashier";
  const navigation = isVenueOnly ? [] : [
    { name: "Аналитика", href: "/dashboard", icon: LayoutDashboard, testId: "dashboard" },
    { name: "Склад", href: "/items", icon: Package, testId: "items" },
    { name: "Тех-карты", href: "/tech-cards", icon: ChefHat, testId: "tech-cards" },
    { name: "Производство", href: "/productions", icon: Factory, testId: "productions" },
    { name: "Перемещения", href: "/transfers", icon: Truck, testId: "transfers" },
    { name: "Категории", href: "/categories", icon: Tags, roles: ["super_admin", "warehouse_chief", "manager"], testId: "categories" },
    { name: "Поступления", href: "/receipts", icon: ArrowDownToLine, testId: "receipts" },
    { name: "Списания", href: "/write-offs", icon: ArrowUpFromLine, roles: ["super_admin", "warehouse_chief", "manager", "accountant"], testId: "write-offs" },
    { name: "Инвентаризация", href: "/inventory-audits", icon: ClipboardCheck, testId: "inventory-audits" },
    { name: "Аренда", href: "/rentals", icon: KeyRound, testId: "rentals" },
    { name: "Контрагенты", href: "/counterparties", icon: Contact, testId: "counterparties" },
    { name: "Сводные отчёты", href: "/summary-reports", icon: BarChart3, testId: "summary-reports" },
    { name: "Отчёты", href: "/reports", icon: FileBarChart, roles: ["super_admin", "warehouse_chief"], testId: "reports" },
    { name: "Журнал аудита", href: "/audit-log", icon: History, roles: ["super_admin"], testId: "audit-log" },
  ];
  const venueNavigation = [
    { name: "Брони", href: "/bookings", icon: CalendarDays, roles: ["super_admin", "location_admin", "manager", "cashier", "warehouse_chief"], testId: "bookings" },
    { name: "ИИ-агент", href: "/ai-agent", icon: Bot, roles: ["super_admin", "location_admin", "manager", "cashier", "warehouse_chief"], testId: "ai-agent" },
    { name: "Гости", href: "/guests", icon: UserRound, roles: ["super_admin", "location_admin", "manager", "cashier", "warehouse_chief"], testId: "guests" },
    { name: "Точки продаж", href: "/houses", icon: Home, roles: ["super_admin", "location_admin"], testId: "houses" },
    { name: "Смены", href: "/shifts", icon: Unlock, roles: ["super_admin", "location_admin", "cashier"], testId: "shifts" },
    { name: "Аналитика касс", href: "/kassa-dashboard", icon: PieChart, roles: ["super_admin", "location_admin"], testId: "kassa-dashboard" },
    { name: "Маржа продаж", href: "/sales-margin", icon: TrendingUp, roles: ["super_admin", "location_admin"], testId: "sales-margin" },
    { name: "Отчёты касс", href: "/kassa-reports", icon: FileBarChart, roles: ["super_admin", "location_admin"], testId: "kassa-reports" },
    { name: "Калькуляции", href: "/kassa-costing", icon: Calculator, roles: ["super_admin", "location_admin"], testId: "kassa-costing" },
  ];
  const PERSONNEL_ADMIN = ["super_admin", "warehouse_chief", "location_admin", "manager"];
  const personnelNavigation = [
    { name: "Задачи", href: "/tasks", icon: ListTodo, roles: undefined as string[] | undefined, testId: "tasks" },
    { name: "Запросы денег", href: "/money-requests", icon: Wallet, roles: undefined as string[] | undefined, testId: "money-requests" },
    { name: "Сотрудники", href: "/staff", icon: Users, roles: [...PERSONNEL_ADMIN, "accountant"], testId: "staff" },
    { name: "График смен", href: "/schedule", icon: CalendarRange, roles: [...PERSONNEL_ADMIN, "accountant"], testId: "schedule" },
    { name: "Табель", href: "/timesheet", icon: Clock, roles: [...PERSONNEL_ADMIN, "accountant"], testId: "timesheet" },
    { name: "Киоск отметок", href: "/kiosk", icon: ScanFace, roles: [...PERSONNEL_ADMIN, "cashier"], testId: "kiosk" },
  ];
  const settingsItem = { name: "Настройки", href: "/settings", icon: Settings, testId: "settings" };
  const closeSidebar = () => setSidebarOpen(false);
  const assignedLocation = user?.locationName;
  const displayLocation = user?.role === "super_admin" || user?.role === "warehouse_chief"
    ? "Все склады"
    : user?.role === "location_admin" || user?.role === "cashier"
    ? (assignedLocation ?? "Площадка не назначена")
    : assignedLocation ?? "Склад не назначен";

  return <div className="flex min-h-[100dvh] bg-background">
    {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={closeSidebar} aria-hidden="true" />}
    <aside className={`print:hidden fixed inset-y-0 left-0 z-40 w-64 flex flex-col bg-sidebar border-r border-sidebar-border text-sidebar-foreground transform transition-transform duration-200 ease-in-out ${sidebarOpen ? "translate-x-0" : "-translate-x-full"} md:relative md:translate-x-0 md:flex`}>
      <div className="p-5 flex items-center justify-between"><img src={`${import.meta.env.BASE_URL}brand/logo-horizontal-white.svg`} alt={BRAND_NAME} className="h-11 w-auto" /><button className="md:hidden p-1" onClick={closeSidebar} aria-label="Закрыть меню"><X className="h-5 w-5" /></button></div>
      <div className="mx-3 mb-4 rounded-xl border border-sidebar-border bg-sidebar-accent/60 p-3"><div className="flex items-center gap-2 text-xs font-semibold text-sidebar-foreground/70"><MapPin className="h-3.5 w-3.5" />{isVenueOnly ? "Площадка" : "Склад"}</div><div className="mt-2 text-sm font-semibold">{displayLocation}</div></div>
      <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto pb-4">
        {navigation.map((item) => { if (item.roles && user?.role && !item.roles.includes(user.role)) return null; const isActive = location === item.href; return <Link key={item.testId} href={item.href}><div className={`flex items-center px-3 py-2.5 text-sm font-medium rounded-md cursor-pointer transition-colors ${isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"}`} data-testid={`nav-${item.testId}`} onClick={closeSidebar}><item.icon className="mr-3 h-5 w-5 flex-shrink-0" />{item.name}</div></Link>; })}
        {([["Касса и зал", venueNavigation], ["Команда", personnelNavigation]] as const).map(([title, items]) => items.some((item) => !item.roles || (user?.role && item.roles.includes(user.role))) && (
          <div key={title} className="pt-3 mt-3 border-t border-sidebar-border/60">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/40">{title}</div>
            {items.map((item) => { if (item.roles && user?.role && !item.roles.includes(user.role)) return null; const isActive = location === item.href; return <Link key={item.testId} href={item.href}><div className={`flex items-center px-3 py-2.5 text-sm font-medium rounded-md cursor-pointer transition-colors ${isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"}`} data-testid={`nav-${item.testId}`} onClick={closeSidebar}><item.icon className="mr-3 h-5 w-5 flex-shrink-0" />{item.name}</div></Link>; })}
          </div>
        ))}
        <div className="pt-3 mt-3 border-t border-sidebar-border/60">
          {(() => { const isActive = location === settingsItem.href; return <Link key={settingsItem.testId} href={settingsItem.href}><div className={`flex items-center px-3 py-2.5 text-sm font-medium rounded-md cursor-pointer transition-colors ${isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"}`} data-testid={`nav-${settingsItem.testId}`} onClick={closeSidebar}><settingsItem.icon className="mr-3 h-5 w-5 flex-shrink-0" />{settingsItem.name}</div></Link>; })()}
        </div>
      </nav>
      <div className="p-4 border-t border-sidebar-border"><div className="flex items-center justify-between gap-2"><div className="text-sm min-w-0"><p className="font-medium truncate">{user?.firstName} {user?.lastName}</p><p className="text-sidebar-foreground/60 text-xs">{user?.role ? (ROLE_LABELS[user.role] ?? user.role) : ""}</p></div><Button variant="ghost" size="icon" className="text-sidebar-foreground hover:bg-sidebar-accent shrink-0" onClick={() => { void signOut().then(() => setLocation("/login")); }}><LogOut className="h-4 w-4" /></Button></div></div>
    </aside>
    <div className="flex-1 flex flex-col min-w-0"><header className="print:hidden sticky top-0 z-20 flex items-center gap-3 px-4 h-14 bg-background border-b border-border md:hidden"><button className="p-2 -ml-2" onClick={() => setSidebarOpen(true)} aria-label="Открыть меню"><Menu className="h-5 w-5" /></button><div className="flex items-center gap-2"><img src={`${import.meta.env.BASE_URL}logo.svg`} alt={BRAND_NAME} className="h-7 w-7 rounded-lg" /><span className="font-bold text-sm">{BRAND_NAME}</span></div></header><main className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8 print:p-0 print:overflow-visible">{children}</main></div>
  </div>;
}
