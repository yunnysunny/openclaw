import { shouldSuppressBuiltInModel as shouldSuppressBuiltInModelImpl } from "./model-suppression.js";
import { shouldSuppressBuiltInModelAsync as shouldSuppressBuiltInModelAsyncImpl } from "./model-suppression.js";

type ShouldSuppressBuiltInModel =
  typeof import("./model-suppression.js").shouldSuppressBuiltInModel;
type ShouldSuppressBuiltInModelAsync =
  typeof import("./model-suppression.js").shouldSuppressBuiltInModelAsync;

export function shouldSuppressBuiltInModel(
  ...args: Parameters<ShouldSuppressBuiltInModel>
): ReturnType<ShouldSuppressBuiltInModel> {
  return shouldSuppressBuiltInModelImpl(...args);
}

export async function shouldSuppressBuiltInModelAsync(
  ...args: Parameters<ShouldSuppressBuiltInModelAsync>
): Promise<ReturnType<ShouldSuppressBuiltInModelAsync>> {
  return shouldSuppressBuiltInModelAsyncImpl(...args);
}
