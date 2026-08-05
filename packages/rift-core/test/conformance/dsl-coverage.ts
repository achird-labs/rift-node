/**
 * DSL expressibility coverage for the conformance corpus (issue #7).
 *
 * `dslCoverage` maps a fixture file name to a builder that reconstructs it — `conformance.test.ts`
 * asserts `normalize(toWireJson({ imposters: [build()] })) deepEquals normalize(fixtureJson)`.
 * `fromJsonOnly` documents fixtures the DSL cannot (yet) express, with the specific wire feature
 * missing a builder. This is an accountability gate, not a backlog: adding a DSL method to close a
 * `fromJsonOnly` gap is out of scope for this issue (it belongs to the DSL issue named in the
 * reason string) — this module only has to keep the map honest as the DSL grows.
 */

import type { Imposter } from '../../src/model/index.js';
import {
  and,
  deepEquals,
  endsWith,
  equals,
  exists,
  imposter,
  json,
  matches,
  not,
  okJson,
  req,
  startsWith,
  status,
  stub,
  type ImposterBuilder,
} from '../../src/dsl/index.js';

function basicApi(): Imposter {
  return imposter('Basic REST API')
    .port(4545)
    .protocol('http')
    .stub(stub().when({ equals: { method: 'GET', path: '/health' } }).willReturn(status(200, 'OK')))
    .stub(
      stub()
        .when({ equals: { method: 'GET', path: '/api/users' } })
        .willReturn(
          okJson([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
          ])
        )
    )
    .stub(
      stub()
        .when(and(req.method(equals('GET')), req.path(matches('/api/users/\\d+'))))
        .willReturn(okJson({ id: 1, name: 'Alice', email: 'alice@example.com' }))
    )
    .stub(
      stub()
        .when({ equals: { method: 'POST', path: '/api/users' } })
        .willReturn(okJson({ id: 999, message: 'Created' }).status(201))
    )
    .build();
}

function errorTesting(): Imposter {
  const err = json;
  return imposter('Error Testing')
    .port(4545)
    .protocol('http')
    .stub(stub().when(req.path('/success')).willReturn(err(200, { status: 'ok' })))
    .stub(
      stub()
        .when(req.path('/error/400'))
        .willReturn(err(400, { error: 'Bad Request', code: 'INVALID_INPUT' }))
    )
    .stub(
      stub()
        .when(req.path('/error/401'))
        .willReturn(
          err(401, { error: 'Unauthorized' }).header('WWW-Authenticate', 'Bearer realm="api"')
        )
    )
    .stub(stub().when(req.path('/error/403')).willReturn(err(403, { error: 'Forbidden' })))
    .stub(stub().when(req.path('/error/404')).willReturn(err(404, { error: 'Not Found' })))
    .stub(
      stub()
        .when(req.path('/error/429'))
        .willReturn(
          err(429, { error: 'Too Many Requests', retry_after: 60 }).header('Retry-After', '60')
        )
    )
    .stub(
      stub().when(req.path('/error/500')).willReturn(err(500, { error: 'Internal Server Error' }))
    )
    .stub(stub().when(req.path('/error/502')).willReturn(err(502, { error: 'Bad Gateway' })))
    .stub(
      stub()
        .when(req.path('/error/503'))
        .willReturn(err(503, { error: 'Service Unavailable' }).header('Retry-After', '30'))
    )
    .stub(stub().when(req.path('/error/504')).willReturn(err(504, { error: 'Gateway Timeout' })))
    .build();
}

function authenticationApi(): Imposter {
  return imposter('Authentication API')
    .port(4547)
    .protocol('http')
    .allowCORS()
    .stub(
      stub()
        .inScenario('Auth-Login-Success')
        .when(req.path('/auth/login'))
        .when(req.method(deepEquals('POST')))
        .when(req.body({ username: 'admin', password: 'secret123' }))
        .willReturn(
          json(200, {
            token:
              'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiJ9.mock',
            expiresIn: 3600,
            tokenType: 'Bearer',
            user: { id: 'user-001', username: 'admin', role: 'admin' },
          })
        )
    )
    .stub(
      stub()
        .inScenario('Auth-Login-InvalidCredentials')
        .when(req.path('/auth/login'))
        .when(req.method(deepEquals('POST')))
        // contains() is string-only; object-contains has no typed matcher — raw wire object to when()
        .when({ contains: { body: { username: 'admin' } } })
        .when(not(req.body(equals({ password: 'secret123' }))))
        .willReturn(
          json(401, { error: 'Invalid credentials', code: 'AUTH_INVALID_CREDENTIALS' })
        )
    )
    .stub(
      stub()
        .inScenario('Auth-Login-UserNotFound')
        .when(req.path('/auth/login'))
        .when(req.method(deepEquals('POST')))
        .when(not({ contains: { body: { username: 'admin' } } }))
        .willReturn(json(401, { error: 'User not found', code: 'AUTH_USER_NOT_FOUND' }))
    )
    .stub(
      stub()
        .inScenario('Auth-ValidateToken-Success')
        .when(req.path('/auth/validate'))
        .when(req.method(deepEquals('GET')))
        .when(req.header('Authorization', exists()))
        .when(req.header('Authorization', startsWith('Bearer ')))
        .willReturn(
          json(200, {
            valid: true,
            user: { id: 'user-001', username: 'admin', role: 'admin' },
          })
        )
    )
    .stub(
      stub()
        .inScenario('Auth-ValidateToken-Missing')
        .when(req.path('/auth/validate'))
        .when(req.method(deepEquals('GET')))
        .when(not(req.header('Authorization', exists())))
        .willReturn(
          json(401, { error: 'Missing authorization header', code: 'AUTH_MISSING_TOKEN' }).header(
            'WWW-Authenticate',
            'Bearer realm="api"'
          )
        )
    )
    .stub(
      stub()
        .inScenario('Auth-Logout-Success')
        .when(req.path('/auth/logout'))
        .when(req.method(deepEquals('POST')))
        .willReturn(json(200, { message: 'Logged out successfully' }))
    )
    .build();
}

function featureFlagsApi(): Imposter {
  return imposter('Feature Flags API')
    .port(4546)
    .protocol('http')
    .allowCORS()
    .stub(
      stub()
        .inScenario('FeatureFlags-DarkMode-Enabled')
        .when(req.path(endsWith('/features/DARK_MODE')))
        .when(req.method(deepEquals('GET')))
        .willReturn(
          json(200, {
            featureId: 'DARK_MODE',
            featureName: 'Dark Mode',
            description: 'Enable dark mode UI theme',
            isEnabled: true,
          })
        )
    )
    .stub(
      stub()
        .inScenario('FeatureFlags-BetaFeature-Disabled')
        .when(req.path(endsWith('/features/BETA_FEATURE')))
        .when(req.method(deepEquals('GET')))
        .willReturn(
          json(200, {
            featureId: 'BETA_FEATURE',
            featureName: 'Beta Feature',
            description: 'New experimental feature',
            isEnabled: false,
          })
        )
    )
    .stub(
      stub()
        .inScenario('FeatureFlags-NotFound')
        .when(req.path(matches('/features/UNKNOWN_.*')))
        .when(req.method(deepEquals('GET')))
        .willReturn(json(404, { error: 'Feature flag not found' }))
    )
    .stub(
      stub()
        .inScenario('FeatureFlags-ListAll')
        .when(req.path('/features'))
        .when(req.method(deepEquals('GET')))
        .willReturn(
          json(200, {
            features: [
              { featureId: 'DARK_MODE', isEnabled: true },
              { featureId: 'BETA_FEATURE', isEnabled: false },
              { featureId: 'NEW_DASHBOARD', isEnabled: true },
            ],
          })
        )
    )
    .build();
}

function taskManagementApi(): Imposter {
  return imposter('Task Management API')
    .port(4545)
    .protocol('http')
    .allowCORS()
    .record()
    .stub(
      stub()
        .inScenario('TaskAPI-GetTasks-FilterByStatus')
        .when(req.path(endsWith('/tasks')))
        .when(req.query('status', 'OPEN'))
        .when(req.method(deepEquals('GET')))
        .willReturn(
          json(200, {
            count: 1,
            tasks: [{ taskId: 'task-001', name: 'Review PR', status: 'OPEN', priority: 'HIGH' }],
          })
        )
    )
    .stub(
      stub()
        .inScenario('TaskAPI-GetTasks-Success')
        .when(req.path(endsWith('/tasks')))
        .when(req.method(deepEquals('GET')))
        .willReturn(
          json(200, {
            count: 3,
            tasks: [
              { taskId: 'task-001', name: 'Review PR', status: 'OPEN', priority: 'HIGH' },
              {
                taskId: 'task-002',
                name: 'Update docs',
                status: 'IN_PROGRESS',
                priority: 'MEDIUM',
              },
              { taskId: 'task-003', name: 'Fix bug', status: 'CLOSED', priority: 'LOW' },
            ],
          })
        )
    )
    .stub(
      stub()
        .inScenario('TaskAPI-GetTaskById-NotFound')
        .when(req.path(matches('^/tasks/task-999$')))
        .when(req.method(deepEquals('GET')))
        .willReturn(json(404, { error: 'Task not found', code: 'TASK_NOT_FOUND' }))
    )
    .stub(
      stub()
        .inScenario('TaskAPI-GetTaskById-Success')
        .when(req.path(matches('/tasks/task-\\d+')))
        .when(req.method(deepEquals('GET')))
        .willReturn(
          json(200, {
            taskId: 'task-001',
            name: 'Review PR',
            description: 'Review the latest pull request for the API changes',
            status: 'OPEN',
            priority: 'HIGH',
            assignee: 'alice@example.com',
            createdAt: '2024-01-15T10:00:00Z',
            updatedAt: '2024-01-15T14:30:00Z',
          })
        )
    )
    .stub(
      stub()
        .inScenario('TaskAPI-CreateTask-Success')
        .when(req.path(endsWith('/tasks')))
        .when(req.method(deepEquals('POST')))
        .when(req.body(exists().jsonpath('$.name')))
        .willReturn(json(201, { taskId: 'task-new-001', message: 'Task created successfully' }))
    )
    .stub(
      stub()
        .inScenario('TaskAPI-CreateTask-ValidationError')
        .when(req.path(endsWith('/tasks')))
        .when(req.method(deepEquals('POST')))
        .when(not(req.body(exists().jsonpath('$.name'))))
        .willReturn(
          json(400, {
            error: 'Validation failed',
            code: 'VALIDATION_ERROR',
            details: [{ field: 'name', message: 'Name is required' }],
          })
        )
    )
    .stub(
      stub()
        .inScenario('TaskAPI-UpdateTask-Success')
        .when(req.path(matches('/tasks/task-\\d+')))
        .when(req.method(deepEquals('PUT')))
        .willReturn(json(200, { message: 'Task updated successfully' }))
    )
    .stub(
      stub()
        .inScenario('TaskAPI-DeleteTask-Success')
        .when(req.path(matches('/tasks/task-\\d+')))
        .when(req.method(deepEquals('DELETE')))
        .willReturn(status(204))
    )
    .build();
}

// A "DSL reconstruction" must be a genuinely TYPED build — using `raw()`/`raw({ stubs })` to splice
// arbitrary wire in would let any fixture masquerade as expressible and hollow out this gate (raw()
// accepts any wire), so raw()-injected wire features do NOT count. Passing a raw wire Predicate
// OBJECT to `when()` is fine where no typed matcher exists for that exact wire shape. Issue #36
// closed the bare-scenarioName gap via `StubBuilder.inScenario(name)` — auth, feature-flags, and
// task-management (whose jsonpath predicates were already typed-expressible) all reconstruct
// through the typed layer now. Only latency-testing.json remains fromJson-only.

export const dslCoverage: Record<string, () => Imposter | ImposterBuilder> = {
  'basic-api.json': basicApi,
  'error-testing.json': errorTesting,
  'authentication-api.json': authenticationApi,
  'feature-flags-api.json': featureFlagsApi,
  'task-management-api.json': taskManagementApi,
};

export const fromJsonOnly: Record<string, string> = {
  'latency-testing.json':
    'wait:{inject} random-delay behavior — latency() deliberately never emits the inject form (#23)',
};
