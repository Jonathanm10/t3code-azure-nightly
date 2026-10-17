import * as Schema from "effect/Schema";

export const Name = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?!\.{1,2}$)[^/\\\r\n\0]+$/u),
);
export const Text = Schema.String.check(Schema.isMaxLength(65536));
export const Id = Schema.Int.check(Schema.isGreaterThan(0));
export const Guid = Schema.String.check(
  Schema.isPattern(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu),
);
export const Commit = Schema.String.check(Schema.isPattern(/^[\da-f]{40}$/iu));
export const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }));
export const Offset = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10000 }));
export const FieldName = Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_.-]{0,255}$/u));
export const FieldValue = Schema.Union([
  Schema.String.check(Schema.isMaxLength(65536)),
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
]);
export const Identity = Schema.Struct({
  id: Guid,
  displayName: Schema.optionalKey(Schema.String),
  uniqueName: Schema.optionalKey(Schema.String),
  imageUrl: Schema.optionalKey(Schema.String),
  vote: Schema.optionalKey(Schema.Int),
  isRequired: Schema.optionalKey(Schema.Boolean),
});
export const Project = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
});
export const Team = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
});
export const Field = Schema.Struct({
  name: Schema.String,
  referenceName: FieldName,
  type: Schema.optionalKey(Schema.String),
  readOnly: Schema.optionalKey(Schema.Boolean),
});
export const WorkItemType = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  fields: Schema.optionalKey(Schema.Array(Field)),
});
export const WorkItemState = Schema.Struct({
  name: Schema.String,
  category: Schema.optionalKey(Schema.String),
  color: Schema.optionalKey(Schema.String),
});
export const Relation = Schema.Struct({
  rel: Schema.String,
  url: Schema.String,
  attributes: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
export const WorkItem = Schema.Struct({
  id: Id,
  rev: Id,
  fields: Schema.Record(Schema.String, Schema.Json),
  relations: Schema.optionalKey(Schema.Array(Relation)),
});
export const WorkItemUpdate = Schema.Struct({
  id: Id,
  rev: Id,
  revisedBy: Schema.optionalKey(Identity),
  revisedDate: Schema.optionalKey(Schema.String),
  fields: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        oldValue: Schema.optionalKey(Schema.Json),
        newValue: Schema.optionalKey(Schema.Json),
      }),
    ),
  ),
});
export const WorkItemComment = Schema.Struct({
  id: Id,
  workItemId: Id,
  text: Schema.String,
  version: Schema.optionalKey(Id),
  createdBy: Schema.optionalKey(Identity),
  createdDate: Schema.optionalKey(Schema.String),
});
export const WorkItemReference = Schema.Struct({ id: Id });
export const WorkItemRelation = Schema.Struct({
  rel: Schema.optionalKey(Schema.NullOr(Schema.String)),
  source: Schema.optionalKey(Schema.NullOr(WorkItemReference)),
  target: WorkItemReference,
});
export const BacklogWorkItems = Schema.Struct({ workItems: Schema.Array(WorkItemRelation) });
export const WorkItemLinks = Schema.Struct({
  workItems: Schema.optionalKey(Schema.Array(WorkItemReference)),
  workItemRelations: Schema.optionalKey(Schema.Array(WorkItemRelation)),
});
export const BoardColumn = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  columnType: Schema.optionalKey(Schema.String),
  isSplit: Schema.optionalKey(Schema.Boolean),
  stateMappings: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export const BoardRow = Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) });
export const Board = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  columns: Schema.optionalKey(Schema.Array(BoardColumn)),
  rows: Schema.optionalKey(Schema.Array(BoardRow)),
  fields: Schema.optionalKey(
    Schema.Struct({
      columnField: Schema.optionalKey(Schema.Struct({ referenceName: FieldName })),
      rowField: Schema.optionalKey(Schema.Struct({ referenceName: FieldName })),
      doneField: Schema.optionalKey(Schema.Struct({ referenceName: FieldName })),
    }),
  ),
});
export const Backlog = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  rank: Schema.optionalKey(Schema.Int),
});
export const Iteration = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  path: Schema.optionalKey(Schema.String),
  attributes: Schema.optionalKey(
    Schema.Struct({
      startDate: Schema.optionalKey(Schema.NullOr(Schema.String)),
      finishDate: Schema.optionalKey(Schema.NullOr(Schema.String)),
      timeFrame: Schema.optionalKey(Schema.String),
    }),
  ),
});
export const Repository = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  name: Schema.String,
  project: Schema.Struct({ id: Schema.optionalKey(Schema.String), name: Schema.String }),
  defaultBranch: Schema.optionalKey(Schema.String),
  webUrl: Schema.optionalKey(Schema.String),
});
export const Branch = Schema.Struct({ name: Schema.String, objectId: Commit });
export const PullRequest = Schema.Struct({
  pullRequestId: Id,
  title: Schema.String,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  isDraft: Schema.optionalKey(Schema.Boolean),
  mergeStatus: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sourceRefName: Schema.String,
  targetRefName: Schema.String,
  creationDate: Schema.String,
  closedDate: Schema.optionalKey(Schema.NullOr(Schema.String)),
  createdBy: Schema.optionalKey(Identity),
  reviewers: Schema.optionalKey(Schema.Array(Identity)),
  repository: Repository,
  lastMergeSourceCommit: Schema.optionalKey(Schema.Struct({ commitId: Commit })),
  autoCompleteSetBy: Schema.optionalKey(Schema.NullOr(Identity)),
  completionOptions: Schema.optionalKey(
    Schema.Struct({
      mergeStrategy: Schema.optionalKey(Schema.String),
      squashMerge: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export const PullRequestIteration = Schema.Struct({
  id: Id,
  sourceRefCommit: Schema.optionalKey(
    Schema.Struct({ commitId: Schema.optionalKey(Schema.String) }),
  ),
  commonRefCommit: Schema.optionalKey(
    Schema.Struct({ commitId: Schema.optionalKey(Schema.String) }),
  ),
});
export const Change = Schema.Struct({
  changeType: Schema.optionalKey(Schema.String),
  sourceServerItem: Schema.optionalKey(Schema.String),
  originalPath: Schema.optionalKey(Schema.String),
  item: Schema.optionalKey(
    Schema.Struct({
      path: Schema.optionalKey(Schema.String),
      objectId: Schema.optionalKey(Schema.String),
      originalObjectId: Schema.optionalKey(Schema.String),
      isFolder: Schema.optionalKey(Schema.Boolean),
      gitObjectType: Schema.optionalKey(Schema.String),
    }),
  ),
});
export const Changes = Schema.Struct({
  changeEntries: Schema.Array(Change),
  nextSkip: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
export const FileContent = Schema.Struct({
  content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  contentMetadata: Schema.optionalKey(
    Schema.Struct({ isBinary: Schema.optionalKey(Schema.Boolean) }),
  ),
});
export const PullRequestComment = Schema.Struct({
  id: Schema.optionalKey(Id),
  content: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Identity),
  publishedDate: Schema.optionalKey(Schema.String),
  isDeleted: Schema.optionalKey(Schema.Boolean),
  commentType: Schema.optionalKey(Schema.Union([Schema.String, Schema.Int])),
});
export const Thread = Schema.Struct({
  id: Id,
  status: Schema.optionalKey(Schema.Union([Schema.String, Schema.Int])),
  isDeleted: Schema.optionalKey(Schema.Boolean),
  threadContext: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ filePath: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
  ),
  comments: Schema.optionalKey(Schema.Array(PullRequestComment)),
});
export const PageInput = {
  limit: Schema.optionalKey(Limit),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16384))),
};
export const ProjectInput = { project: Name };
export const TeamInput = { ...ProjectInput, team: Name };
export const RepositoryInput = { ...ProjectInput, repository: Name };
export const PullRequestInput = { ...RepositoryInput, pullRequestId: Id };
export const WorkItemInput = { ...ProjectInput, id: Id };
export const RevisionInput = { ...WorkItemInput, expectedRevision: Id };
export const BoardInput = { ...TeamInput, board: Name };
export const Empty = Schema.Struct({});
export const pageOf = <S extends Schema.Constraint>(item: S) =>
  Schema.Struct({ items: Schema.Array(item), next: Schema.NullOr(Schema.String) });
