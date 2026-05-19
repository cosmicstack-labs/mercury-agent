import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AppLayout } from "./components/layout/AppLayout";

// Lazy-loaded pages for code splitting
const LoginPage = lazy(() => import("./pages/Login").then((m) => ({ default: m.LoginPage })));
const DashboardPage = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.DashboardPage })));
const ChatPage = lazy(() => import("./pages/Chat").then((m) => ({ default: m.ChatPage })));
const TasksPage = lazy(() => import("./pages/Tasks").then((m) => ({ default: m.TasksPage })));
const KanbanPage = lazy(() => import("./pages/Kanban").then((m) => ({ default: m.KanbanPage })));
const MemoryPage = lazy(() => import("./pages/brain/Memory").then((m) => ({ default: m.MemoryPage })));
const PersonsPage = lazy(() => import("./pages/brain/Persons").then((m) => ({ default: m.PersonsPage })));
const PersonDetailPage = lazy(() => import("./pages/brain/PersonDetail").then((m) => ({ default: m.PersonDetailPage })));
const GoalsPage = lazy(() => import("./pages/brain/Goals").then((m) => ({ default: m.GoalsPage })));
const GraphPage = lazy(() => import("./pages/brain/Graph").then((m) => ({ default: m.GraphPage })));
const ProvidersPage = lazy(() => import("./pages/Providers").then((m) => ({ default: m.ProvidersPage })));
const SkillsPage = lazy(() => import("./pages/Skills").then((m) => ({ default: m.SkillsPage })));
const PermissionsPage = lazy(() => import("./pages/Permissions").then((m) => ({ default: m.PermissionsPage })));
const SchedulesPage = lazy(() => import("./pages/Schedules").then((m) => ({ default: m.SchedulesPage })));
const UsagePage = lazy(() => import("./pages/Usage").then((m) => ({ default: m.UsagePage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));
const WorkspacePage = lazy(() => import("./pages/Workspace").then((m) => ({ default: m.WorkspacePage })));

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-full min-h-[200px]">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        <span className="text-sm text-muted-foreground">Loading...</span>
      </div>
    </div>
  );
}

const pageTransition = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.2, ease: "easeInOut" as const },
};

function AnimatedPage({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      className="flex-1 min-h-0"
      initial={pageTransition.initial}
      animate={pageTransition.animate}
      exit={pageTransition.exit}
      transition={pageTransition.transition}
    >
      {children}
    </motion.div>
  );
}

function AnimatedRoutes() {
  const location = useLocation();

  return (
    <AnimatePresence mode="wait">
      <Suspense fallback={<PageLoader />} key={location.pathname}>
        <Routes location={location}>
          <Route path="/login" element={<AnimatedPage><LoginPage /></AnimatedPage>} />
          <Route element={<AppLayout />}>
            <Route index element={<AnimatedPage><DashboardPage /></AnimatedPage>} />
            <Route path="chat" element={<ChatPage />} />
            <Route path="chat/:threadId" element={<ChatPage />} />
            <Route path="tasks" element={<AnimatedPage><TasksPage /></AnimatedPage>} />
            <Route path="board" element={<AnimatedPage><KanbanPage /></AnimatedPage>} />
            <Route path="board/:boardId" element={<AnimatedPage><KanbanPage /></AnimatedPage>} />
            <Route path="workspace" element={<WorkspacePage />} />
            <Route path="second-brain/memory" element={<AnimatedPage><MemoryPage /></AnimatedPage>} />
            <Route path="second-brain/persons" element={<AnimatedPage><PersonsPage /></AnimatedPage>} />
            <Route path="second-brain/persons/:id" element={<AnimatedPage><PersonDetailPage /></AnimatedPage>} />
            <Route path="second-brain/goals" element={<AnimatedPage><GoalsPage /></AnimatedPage>} />
            <Route path="second-brain/graph" element={<AnimatedPage><GraphPage /></AnimatedPage>} />
            <Route path="providers" element={<AnimatedPage><ProvidersPage /></AnimatedPage>} />
            <Route path="skills" element={<AnimatedPage><SkillsPage /></AnimatedPage>} />
            <Route path="permissions" element={<AnimatedPage><PermissionsPage /></AnimatedPage>} />
            <Route path="schedules" element={<AnimatedPage><SchedulesPage /></AnimatedPage>} />
            <Route path="usage" element={<AnimatedPage><UsagePage /></AnimatedPage>} />
            <Route path="settings" element={<AnimatedPage><SettingsPage /></AnimatedPage>} />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </AnimatePresence>
  );
}

export function App() {
  return <AnimatedRoutes />;
}
