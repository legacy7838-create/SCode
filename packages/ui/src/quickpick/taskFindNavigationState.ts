interface TaskFindNavigationState {
  activeIndex: number;
  navigationRequestId: number;
  query: string;
}

export function createTaskFindNavigationState(): TaskFindNavigationState {
  return {
    activeIndex: -1,
    navigationRequestId: 0,
    query: "",
  };
}

export function changeTaskFindSelection(
  state: TaskFindNavigationState,
  query: string,
  activeIndex: number,
): TaskFindNavigationState {
  return {
    activeIndex,
    navigationRequestId: state.navigationRequestId,
    query,
  };
}

export function navigateTaskFindSelection(
  state: TaskFindNavigationState,
  query: string,
  activeIndex: number,
): TaskFindNavigationState {
  // query/index does not change when a single hit wraps around, and the navigation identity must be independently incremented in the state holding layer.
  // Put the three states in the same transition to prevent multiple setters of the App from being broken up by subsequent maintenance.
  return {
    activeIndex,
    navigationRequestId: state.navigationRequestId + 1,
    query,
  };
}
