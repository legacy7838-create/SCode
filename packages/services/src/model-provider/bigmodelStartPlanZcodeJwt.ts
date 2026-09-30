import { BIGMODEL_PROVIDER_ID } from "@zcode/shared";

const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";

interface BigModelStartPlanZcodeJwtCredentialService {
  load(key: string): Promise<string | null>;
}

export async function resolveBigModelStartPlanZcodeJwt(params: {
  credentialService?: BigModelStartPlanZcodeJwtCredentialService;
  provider?: { readonly apiKey?: string | null } | null;
  trustCachedZcodeJwt?: boolean;
}): Promise<string> {
  const activeProvider = (await params.credentialService?.load(ACTIVE_PROVIDER_KEY))?.trim() || "";
  if (params.trustCachedZcodeJwt === true || activeProvider === BIGMODEL_PROVIDER_ID) {
    const credentialJwt = (await params.credentialService?.load(ZCODE_JWT_TOKEN_KEY))?.trim() || "";
    if (credentialJwt) {
      return credentialJwt;
    }
  }

  // The zcode JWT must be placed using the authorization code body during the BigModel OAuth callback phase.
  // Start Plan only consumes the saved JWT or provider copy when querying the balance/running and no longer uses it.
  // BigModel access_token constructs provider+access_token body for temporary redemption to avoid /oauth/token 400.
  return params.provider?.apiKey?.trim() || "";
}
