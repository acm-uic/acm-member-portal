using AcmProvisioning;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<AdProvisioningService>();
var app = builder.Build();

// Bearer token on everything except /healthz
app.UseMiddleware<TokenAuthMiddleware>();

app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));

app.MapPost("/users", async Task<IResult> (CreateUserRequest req, AdProvisioningService ad) =>
{
    if (string.IsNullOrWhiteSpace(req.Netid) || string.IsNullOrWhiteSpace(req.FirstName)
        || string.IsNullOrWhiteSpace(req.LastName) || string.IsNullOrWhiteSpace(req.DisplayName)
        || string.IsNullOrWhiteSpace(req.Email) || string.IsNullOrWhiteSpace(req.EventId))
    {
        return Results.BadRequest(new { error = "netid, firstName, lastName, displayName, email, and eventId are required." });
    }

    try
    {
        var result = await ad.CreateUserAsync(req);
        return Results.Ok(result);
    }
    catch (ProvisioningException ex)
    {
        return Results.Problem(ex.Message, statusCode: 502);
    }
});

app.MapGet("/users/{netid}", async Task<IResult> (string netid, AdProvisioningService ad) =>
{
    var exists = await ad.UserExistsAsync(netid);
    return exists
        ? Results.Ok(new { samAccountName = netid, existed = true })
        : Results.NotFound(new { samAccountName = netid, existed = false });
});

app.Run();
