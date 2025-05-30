import gql from 'graphql-tag';

import { ExpoGraphqlClient } from '../../commandUtils/context/contextUtils/createGraphqlClient';
import { withErrorHandlingAsync } from '../client';
import {
  WorkflowRunByIdQuery,
  WorkflowRunByIdQueryVariables,
  WorkflowRunByIdWithJobsQuery,
  WorkflowRunByIdWithJobsQueryVariables,
} from '../generated';

export const WorkflowRunQuery = {
  async byIdAsync(
    graphqlClient: ExpoGraphqlClient,
    workflowRunId: string,
    { useCache = true }: { useCache?: boolean } = {}
  ): Promise<WorkflowRunByIdQuery['workflowRuns']['byId']> {
    const data = await withErrorHandlingAsync(
      graphqlClient
        .query<WorkflowRunByIdQuery, WorkflowRunByIdQueryVariables>(
          gql`
            query WorkflowRunById($workflowRunId: ID!) {
              workflowRuns {
                byId(workflowRunId: $workflowRunId) {
                  id
                  status
                }
              }
            }
          `,
          { workflowRunId },
          {
            requestPolicy: useCache ? 'cache-first' : 'network-only',
            additionalTypenames: ['WorkflowRun'],
          }
        )
        .toPromise()
    );
    return data.workflowRuns.byId;
  },
  async withJobsByIdAsync(
    graphqlClient: ExpoGraphqlClient,
    workflowRunId: string,
    { useCache = true }: { useCache?: boolean } = {}
  ): Promise<WorkflowRunByIdWithJobsQuery['workflowRuns']['byId']> {
    const data = await withErrorHandlingAsync(
      graphqlClient
        .query<WorkflowRunByIdWithJobsQuery, WorkflowRunByIdWithJobsQueryVariables>(
          gql`
            query WorkflowRunByIdWithJobs($workflowRunId: ID!) {
              workflowRuns {
                byId(workflowRunId: $workflowRunId) {
                  id
                  name
                  status
                  createdAt

                  workflow {
                    id
                    name
                    fileName
                  }

                  jobs {
                    id
                    key
                    name
                    type
                    status
                    outputs
                    createdAt
                  }
                }
              }
            }
          `,
          { workflowRunId },
          {
            requestPolicy: useCache ? 'cache-first' : 'network-only',
            additionalTypenames: ['WorkflowRun'],
          }
        )
        .toPromise()
    );
    return data.workflowRuns.byId;
  },
};
